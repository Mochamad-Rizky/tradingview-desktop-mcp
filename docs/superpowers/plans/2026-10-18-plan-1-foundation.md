# Plan 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A publishable, fully tested MCP server skeleton that connects to TradingView Desktop over CDP and ships the App and Chart tool domains, `batch_run`, both transports, the test harnesses, and CI.

**Architecture:** pnpm monorepo. `packages/server` holds a core layer (CDP discovery, sessions, page bridge, tier runner, launcher), a tool registry that wraps every handler in one result envelope, and stdio plus Streamable HTTP transports. Integration tests run the real server against a fake CDP server whose `Runtime.evaluate` executes the real page functions against a fixture-backed fake TradingView window.

**Tech Stack:** TypeScript 6.0.x (strict), Node ≥22.22 for development (runtime ≥20.19), pnpm 12, `@modelcontextprotocol/sdk` 1.32.x, zod 4, chrome-remote-interface 0.34 + devtools-protocol, pino 10, picocolors, tsup 9, Vitest 5, ESLint 10 + typescript-eslint 8, Prettier 3, Husky 9, lint-staged 17, commitlint 21, ws 8 (tests).

**Spec:** [docs/superpowers/specs/2026-10-18-tradingview-mcp-design.md](../specs/2026-10-18-tradingview-mcp-design.md) and [docs/reverse-engineering.md](../../reverse-engineering.md).

## Global Constraints

- TypeScript strict mode, **no `any`** (`@typescript-eslint/no-explicit-any: error`), ESM only.
- Runtime `engines.node` is `>=20.19`; development uses Node 24 (`.nvmrc`), and tooling requires Node ≥22.22.
- Package name `tradingview-desktop-mcp` (pending approval; substitute the approved name everywhere), bin of the same name.
- Tool names are `snake_case` with a domain prefix; every input has a Zod schema with `.describe()` text.
- Logs go to stderr only (pino on fd 2); `no-console` is an ESLint error in `packages/server/src`; stdout is reserved for JSON-RPC in stdio mode.
- All code comments, docs, logs, errors, CLI output, and test names are in English. Comments explain why, not what.
- Coverage ≥80% (lines, branches, functions, statements) for `packages/server/src`, from unit and integration tests together.
- Conventional Commits, small and atomic, authored with the local git identity. **No AI attribution** in commits, PRs, or code.
- Never pass `--options=clean` or `--remote-debugging-address` to TradingView. CDP host must be loopback.
- Only automate the local, logged-in app. No authentication, paywall, or plan-limit bypass. No direct calls to TradingView servers.
- Committed fixtures contain no personal data and only synthetic prices.

## Review Focus

1. **TradingView not running, or running without the debug port:** every tool returns `TV_NOT_RUNNING`, `CDP_UNREACHABLE`, or `RESTART_REQUIRED` with an actionable hint within the call timeout; nothing hangs. Pinned in Task 10 (`health reports cdp unreachable within timeout`) and Task 11 (`running without CDP and restart=false throws RESTART_REQUIRED`).
2. **Several TradingView tabs open:** tools act on the visible tab, never on a background tab. Pinned in Task 10 (`selects the visible tab when two chart targets exist`).
3. **Unknown or delisted symbol:** `chart_set_symbol` returns `INVALID_INPUT` ("Unknown symbol …") and reports that the chart kept its previous symbol, instead of timing out silently. Pinned in Task 16 (`chart_set_symbol rejects an unknown symbol`).
4. **Time inputs in mixed units and zones:** ISO strings with offsets, Unix seconds, and Unix milliseconds all resolve to the same instant. Pinned in Task 4 (`parseTimeInput treats values above 1e11 as milliseconds`, `parseTimeInput honors ISO offsets`).
5. **Stdout pollution in stdio mode:** a stray log line would corrupt the protocol. Pinned in Task 14 (`stdio stdout carries only JSON-RPC`).

---

### Task 1: Monorepo scaffold and quality tooling

**Files:**

- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, `.editorconfig`, `.gitignore`, `.nvmrc`, `commitlint.config.js`, `.lintstagedrc.json`, `.husky/pre-commit`, `.husky/commit-msg`, `LICENSE`
- Create: `packages/server/package.json`, `packages/server/tsconfig.json`, `packages/server/tsup.config.ts`, `packages/server/vitest.config.ts`, `packages/server/src/index.ts`, `packages/server/src/version.ts`
- Test: `packages/server/test/unit/version.test.ts`

**Interfaces:**

- Produces: `export const VERSION: string` in `src/version.ts` (read from `package.json` at build time through a JSON import); root scripts `lint`, `typecheck`, `format`, `test`, `test:unit`, `test:integration`, `test:e2e`, `test:coverage`, `build`.

- [ ] **Step 1: Create the workspace config.** Root `package.json`: `"private": true`, `"type": "module"`, `"packageManager": "pnpm@12.14.0"`, `"engines": {"node": ">=22.22"}`. Scripts delegate with `pnpm -r --if-present <script>`. `pnpm-workspace.yaml` lists `packages/*`. `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `module`/`moduleResolution` `NodeNext`, `target` `ES2022`, `lib` `["ES2023", "DOM"]` (page functions use DOM types).
- [ ] **Step 2: Configure ESLint, Prettier, Husky, lint-staged, and commitlint.** ESLint flat config with `typescript-eslint` `strictTypeChecked` and `stylisticTypeChecked`, `no-console: error` and `@typescript-eslint/no-explicit-any: error` for `packages/*/src/**`. Prettier: `printWidth 100`, `singleQuote true`, `trailingComma all`. lint-staged runs `eslint --fix` and `prettier --write` on staged files. commitlint extends `@commitlint/config-conventional`.
- [ ] **Step 3: Write the failing test** `packages/server/test/unit/version.test.ts`:

```ts
import pkg from '../../package.json' with { type: 'json' };
import { VERSION } from '../../src/version.js';

test('VERSION matches package.json version', () => {
  expect(VERSION).toBe(pkg.version);
});
```

- [ ] **Step 4: Configure the server package.** `package.json`: name `tradingview-desktop-mcp`, `version 0.1.0`, `type module`, `engines.node ">=20.19"`, `bin {"tradingview-desktop-mcp": "./dist/cli.js"}`, `exports {".": "./dist/index.js"}`, `files ["dist"]`, scripts `build`, `typecheck` (`tsc --noEmit`), `test:unit` (`vitest run --project unit`), `test:integration` (`vitest run --project integration`), `test:e2e` (`vitest run --project e2e`), `test:coverage` (`vitest run --project unit --project integration --coverage`). `vitest.config.ts` defines projects `unit` (`test/unit/**/*.test.ts`), `integration` (`test/integration/**/*.test.ts`, `testTimeout 30000`), and `e2e` (`test/e2e/**/*.e2e.test.ts`, `testTimeout 120000`, `fileParallelism false`), with v8 coverage over `src/**` and thresholds of 80 for lines, branches, functions, and statements. `tsup.config.ts`: entries `src/cli.ts` and `src/index.ts`, `format esm`, `target node20`, `dts true` for `index.ts` only, `clean true`.
- [ ] **Step 5: Run the test to verify it fails.** Run: `pnpm install && pnpm test:unit`. Expected: FAIL, cannot resolve `../../src/version.js`.
- [ ] **Step 6: Implement `export const VERSION: string` in `src/version.ts`**, and re-export it from `src/index.ts`.
- [ ] **Step 7: Verify the whole toolchain.** Run: `pnpm lint && pnpm typecheck && pnpm test:unit && pnpm build`. Expected: all pass; `packages/server/dist/index.js` exists.
- [ ] **Step 8: Commit.**

```bash
git add -A
git commit -m "chore: scaffold pnpm monorepo with TypeScript, ESLint, Prettier and Vitest"
```

(`main` already exists from the Phase 1 documentation commits.)

---

### Task 2: Errors, JSON types, result envelope, logger, and event bus

**Files:**

- Create: `src/utils/json.ts`, `src/core/errors.ts`, `src/core/result.ts`, `src/core/logger.ts`, `src/core/events.ts`
- Test: `test/unit/core/errors.test.ts`, `test/unit/core/result.test.ts`, `test/unit/core/logger.test.ts`, `test/unit/core/events.test.ts`

(All `src/` and `test/` paths in this plan are relative to `packages/server/`.)

**Interfaces:**

- Produces:
  - `type JsonPrimitive = string | number | boolean | null`, `type JsonValue = JsonPrimitive | JsonValue[] | { [k: string]: JsonValue }`, `type JsonObject = { [k: string]: JsonValue }`
  - `type ErrorCode` = the 16 codes of spec §5.2; `interface ErrorPayload { code: ErrorCode; message: string; hint?: string; details?: JsonObject }`
  - `class TvMcpError extends Error { readonly code: ErrorCode; readonly hint?: string; readonly details?: JsonObject; constructor(code: ErrorCode, message: string, options?: { hint?: string; details?: JsonObject; cause?: unknown }); toPayload(): ErrorPayload }`
  - `class PlanLimitError extends TvMcpError` with `constructor(feature: string, limit: number, message?: string)` → code `PLAN_LIMIT`, `details {feature, limit}`
  - `class TimeoutError extends TvMcpError` with `constructor(label: string, ms: number)` → code `TIMEOUT`
  - `class CapabilityError extends TvMcpError` with `constructor(message: string, attempts?: string[])` → code `CAPABILITY_UNAVAILABLE`
  - `function isTvMcpError(err: unknown): err is TvMcpError`, `function toErrorPayload(err: unknown): ErrorPayload`
  - `type Tier = 'api' | 'internal' | 'dom' | 'keyboard' | 'cdp' | 'local'`; `interface ToolMeta { via?: Tier; durationMs: number; warnings?: string[] }`
  - `function toSuccessResult(data: JsonValue, meta: ToolMeta, images?: ImageContent[]): CallToolResult`, `function toErrorResult(error: ErrorPayload, durationMs: number): CallToolResult`
  - `type Logger = pino.Logger`; `function createLogger(options: { level: LogLevel; destination?: pino.DestinationStream }): Logger` (default destination `pino.destination(2)`)
  - `interface ToolCallEvent { id: string; tool: string; origin: 'mcp' | 'batch' | 'dashboard'; phase: 'start' | 'end'; at: string; durationMs?: number; ok?: boolean; errorCode?: ErrorCode; args?: JsonValue }`; `class ToolEventBus { emit(e: ToolCallEvent): void; subscribe(fn: (e: ToolCallEvent) => void): () => void; recent(limit?: number): ToolCallEvent[] }` (ring buffer of 500)

- [ ] **Step 1: Write the failing tests.**

```ts
test('TvMcpError carries code, hint and details', () => {
  const e = new TvMcpError('TARGET_NOT_FOUND', 'No chart tab', {
    hint: 'Open a chart',
    details: { tabs: 0 },
  });
  expect(e.toPayload()).toEqual({
    code: 'TARGET_NOT_FOUND',
    message: 'No chart tab',
    hint: 'Open a chart',
    details: { tabs: 0 },
  });
});
test('toErrorPayload maps unknown errors to INTERNAL without leaking the stack', () => {
  const p = toErrorPayload(new Error('boom'));
  expect(p.code).toBe('INTERNAL');
  expect(JSON.stringify(p)).not.toContain('at ');
});
test('PlanLimitError exposes feature and limit', () => {
  expect(new PlanLimitError('INDICATORS_ON_CHART', 2).toPayload().details).toEqual({
    feature: 'INDICATORS_ON_CHART',
    limit: 2,
  });
});
test('toSuccessResult mirrors the payload in text and structuredContent', () => {
  const r = toSuccessResult({ a: 1 }, { via: 'api', durationMs: 5 });
  expect(r.structuredContent).toEqual({
    ok: true,
    data: { a: 1 },
    meta: { via: 'api', durationMs: 5 },
  });
  expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual(r.structuredContent);
});
test('toErrorResult sets isError and the error code', () => {
  const r = toErrorResult({ code: 'TIMEOUT', message: 't' }, 3);
  expect(r.isError).toBe(true);
  expect(r.structuredContent).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
});
test('logger writes to the given destination and never to stdout', () => {
  /* spy on process.stdout.write; assert not called; assert destination received one JSON line */
});
test('ToolEventBus keeps the most recent 500 events and notifies subscribers', () => {
  /* emit 501 events; recent() has 500; subscriber called 501 times; unsubscribe stops calls */
});
```

- [ ] **Step 2: Run the tests to verify they fail.** Run: `pnpm -C packages/server vitest run --project unit test/unit/core`. Expected: FAIL, modules not found.
- [ ] **Step 3: Implement the five modules** with the signatures above. `toErrorPayload` passes `TvMcpError` payloads through, and maps everything else to `{ code: 'INTERNAL', message: 'Unexpected error' }` with the original message only in the log.
- [ ] **Step 4: Run the tests to verify they pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(core): add typed errors, result envelope, stderr logger and tool event bus"`

---

### Task 3: Configuration from environment and CLI flags

**Files:**

- Create: `src/config/schema.ts`, `src/config/load.ts`, `.env.example` (repository root)
- Test: `test/unit/config/load.test.ts`

**Interfaces:**

- Consumes: `TvMcpError` (Task 2).
- Produces:
  - `type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent'`, `type Profile = 'core' | 'full' | 'readonly'`, `type CliCommand = 'serve' | 'launch' | 'doctor' | 'config'`
  - `interface Config { cdpHost: string; cdpPort: number; appPath?: string; launchTimeoutMs: number; callTimeoutMs: number; logLevel: LogLevel; transport: 'stdio' | 'http'; httpHost: string; httpPort: number; authToken?: string; profile: Profile; toolPatterns: string[]; allowEval: boolean; dashboard: boolean }`
  - `function loadConfig(input: { argv: string[]; env: NodeJS.ProcessEnv }): { command: CliCommand; commandArgs: string[]; config: Config }`

- [ ] **Step 1: Write the failing tests** (names and key assertions):
  - `uses documented defaults` → `cdpHost '127.0.0.1'`, `cdpPort 9222`, `launchTimeoutMs 60000`, `callTimeoutMs 15000`, `transport 'stdio'`, `httpPort 8787`, `profile 'full'`, `allowEval false`, `dashboard false`.
  - `CLI flags override environment variables` → env `TV_CDP_PORT=9333` with `--cdp-port 9444` gives `9444`.
  - `rejects a non-loopback CDP host` → `TV_CDP_HOST=192.168.1.5` throws a `TvMcpError` with code `INVALID_INPUT`.
  - `requires an auth token for the HTTP transport` → `--transport http` without `TV_MCP_AUTH_TOKEN` throws `INVALID_INPUT` with hint containing `TV_MCP_AUTH_TOKEN`.
  - `enables the dashboard by default in HTTP mode` → `dashboard true`, and `--no-dashboard` turns it off.
  - `parses tool patterns` → `TV_MCP_TOOLS="chart_*, data_get_ohlcv"` gives `['chart_*', 'data_get_ohlcv']`.
  - `parses subcommands` → `['launch']` gives `command 'launch'`; `['config', 'cursor']` gives `commandArgs ['cursor']`.
- [ ] **Step 2: Run the tests to verify they fail.** Run: `pnpm -C packages/server vitest run --project unit test/unit/config`. Expected: FAIL.
- [ ] **Step 3: Implement `loadConfig`** with `node:util.parseArgs` (flags from spec §9) and a zod schema. Accepted loopback hosts: `127.0.0.1`, `localhost`, `::1`. Write `.env.example` listing every variable from spec §9 with its default and a one-line comment.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(config): load configuration from environment and CLI flags"`

---

### Task 4: Timeout, retry, and time utilities

**Files:**

- Create: `src/utils/timeout.ts`, `src/utils/retry.ts`, `src/utils/time.ts`
- Test: `test/unit/utils/timeout.test.ts`, `test/unit/utils/retry.test.ts`, `test/unit/utils/time.test.ts`

**Interfaces:**

- Produces:
  - `function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T>` (rejects with `TimeoutError(label, ms)` and clears its timer); `function sleep(ms: number): Promise<void>`
  - `interface RetryOptions { retries: number; baseDelayMs: number; maxDelayMs: number; shouldRetry: (err: unknown) => boolean; sleep?: (ms: number) => Promise<void>; random?: () => number }`; `function retry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T>` (exponential backoff with full jitter)
  - `function parseTimeInput(input: string | number): number` (Unix seconds); `function toIso(seconds: number): string`

- [ ] **Step 1: Write the failing tests.**
  - `withTimeout resolves fast work` and `withTimeout rejects slow work with TIMEOUT` (fake timers; assert `code === 'TIMEOUT'` and `details` include the label).
  - `retry stops after the configured retries`: a function failing 4 times with `retries: 3` is called 4 times, then rejects with the last error.
  - `retry does not retry when shouldRetry returns false`: called once.
  - `retry delays grow exponentially and are capped`: with `random: () => 1`, recorded sleeps are `[100, 200, 400]` for base 100 and max 400.
  - `parseTimeInput accepts Unix seconds`: `parseTimeInput(1700000000) === 1700000000`.
  - `parseTimeInput treats values above 1e11 as milliseconds`: `parseTimeInput(1700000000000) === 1700000000`.
  - `parseTimeInput honors ISO offsets`: `parseTimeInput('2023-11-14T22:13:20Z') === 1700000000` and `parseTimeInput('2023-11-15T05:13:20+07:00') === 1700000000`.
  - `parseTimeInput rejects garbage with INVALID_INPUT`: `'yesterday-ish'` throws.
- [ ] **Step 2: Run the tests to verify they fail.** Run: `pnpm -C packages/server vitest run --project unit test/unit/utils`. Expected: FAIL.
- [ ] **Step 3: Implement the three modules.** Date-only ISO strings (`2024-01-31`) mean midnight UTC.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(utils): add timeout, retry and time parsing helpers"`

---

### Task 5: Test harness: fake CDP server and fake TradingView window

**Files:**

- Create: `test/helpers/fake-cdp/server.ts`, `test/helpers/fake-tv/fixture.ts`, `test/helpers/fake-tv/window.ts`, `test/helpers/fake-tv/synthetic-bars.ts`
- Create: `test/fixtures/cdp/targets.macos-3.4.1.json` (observed target list from reverse-engineering §3.2 with the layout ID replaced by `FIXTURE1`), `test/fixtures/tv/chart-basic.json`, `test/fixtures/png/1x1.png`
- Test: `test/unit/helpers/fake-cdp-server.test.ts`, `test/unit/helpers/fake-tv-window.test.ts`

**Interfaces:**

- Produces (test-only):
  - `interface FakeTarget { id: string; type: string; title: string; url: string; behavior: 'page' | 'silent'; window?: () => object; handlers?: Record<string, (params: unknown) => unknown> }`
  - `function startFakeCdpServer(options: { targets: FakeTarget[] }): Promise<FakeCdpServer>`; `interface FakeCdpServer { host: '127.0.0.1'; port: number; calls: { targetId: string; method: string; params: unknown }[]; setTargets(targets: FakeTarget[]): void; dropConnections(): void; close(): Promise<void> }`
  - Serves `/json/version` and `/json/list`, and WebSocket CDP on `/devtools/page/<id>`. `silent` targets never answer. Default `Runtime.evaluate` runs `expression` in `vm.createContext({ window })` with `awaitPromise`, JSON round-trips the result (emulating `returnByValue`), and returns `exceptionDetails` with `exception.description` on throw. Default `Page.captureScreenshot` returns `1x1.png` as base64. `Input.*` calls are recorded and answered with `{}`.
  - `interface TvStateFixture { buildTime: string; symbol: string; resolution: string; chartType: number; visibleRange: { from: number; to: number }; studies: { id: string; name: string; plots: string[] }[]; shapes: { id: string; name: string }[]; layout: { type: string; chartsCount: number; name: string; id: string }; intervals: string[]; knownSymbols: string[]; symbolInfo: Record<string, JsonValue>; quote: Record<string, JsonValue>; bars: { count: number; startTime: number; stepSeconds: number; seed: number } }`
  - `function createFakeTvWindow(fixture: TvStateFixture, overrides?: { visibilityState?: 'visible' | 'hidden'; withoutApi?: boolean }): object`, which mimics every member listed in reverse-engineering §4.2 to §4.4 that Plan 1 uses: `TradingViewApi.activeChart()`, `chart(i)`, `chartsCount()`, `activeChartIndex()`, `layout()`, `layoutName()`, `layoutId()`, `isConnected()`, `getIntervals()`, `setActiveChart()`; chart `symbol()`, `resolution()`, `chartType()`, `getVisibleRange()`, `getAllStudies()`, `getAllShapes()`, `setSymbol()` (calls `dataReady` asynchronously, and marks the series invalid for symbols outside `knownSymbols`), `setResolution()`, `setChartType()`, `setVisibleRange()` (throws "Not implemented", like the real build), `_chartWidget.model().mainSeries()` with `bars()`, `symbolInfo()`, `quotes()`, `isSymbolInvalid()`, and `_chartWidget.model().model().timeScale()` with `zoomToBarsRange()`, `scrollToBar()`, `timePointToIndex()`, `logicalRange()`; plus `document.visibilityState`, `location.href`, `BUILD_TIME`, and `TVD.reloadTab()`.
  - `function syntheticBars(spec: TvStateFixture['bars']): [number, number, number, number, number, number][]` (deterministic random walk; volume ≥ 0; `high ≥ max(open, close)`, `low ≤ min(open, close)`).

- [ ] **Step 1: Write the failing tests.**
  - `serves the target list with WebSocket URLs`: `fetch('/json/list')` returns the targets with `webSocketDebuggerUrl` set to `ws://127.0.0.1:<port>/devtools/page/<id>`.
  - `evaluates expressions against the fake window`: sending `Runtime.evaluate` with `window.TradingViewApi.activeChart().symbol()` returns the fixture symbol.
  - `returns exceptionDetails when the expression throws`.
  - `never answers silent targets`: no response within 300 ms.
  - `records Input calls`.
  - `syntheticBars is deterministic and well-formed`: the same seed gives identical output, and the OHLC invariants hold for every bar.
  - `fake setSymbol marks unknown symbols invalid`.
- [ ] **Step 2: Run the tests to verify they fail.** Run: `pnpm -C packages/server vitest run --project unit test/unit/helpers`. Expected: FAIL.
- [ ] **Step 3: Implement the helpers and fixtures.** `chart-basic.json` uses symbol `NASDAQ:AAPL`, resolution `1D`, chart type `1`, two studies, three shapes, layout `{ type: 's', chartsCount: 1, name: 'Fixture Layout', id: 'FIXTURE1' }`, and synthetic bars (`count 300`, daily step).
- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "test: add fake CDP server and fixture-backed fake TradingView window"`

---

### Task 6: CDP discovery and target classification

**Files:**

- Create: `src/core/cdp/types.ts`, `src/core/cdp/discovery.ts`, `src/core/cdp/targets.ts`
- Test: `test/unit/core/cdp/targets.test.ts`, `test/integration/cdp-discovery.test.ts`

**Interfaces:**

- Consumes: `TvMcpError`, `withTimeout` (Tasks 2 and 4); `startFakeCdpServer` (Task 5).
- Produces:
  - `interface CdpTargetInfo { id: string; type: string; title: string; url: string; webSocketDebuggerUrl?: string; parentId?: string }`
  - `interface CdpVersionInfo { browser: string; protocolVersion: string; userAgent: string; v8Version?: string }`
  - `interface CdpDiscovery { version(): Promise<CdpVersionInfo>; targets(): Promise<CdpTargetInfo[]> }`; `function createHttpDiscovery(options: { host: string; port: number; timeoutMs: number }): CdpDiscovery`
  - `type TargetKind = 'chart' | 'window-chrome' | 'helper' | 'blank' | 'other'`; `function classifyTarget(t: CdpTargetInfo): TargetKind`; `function findChartTargets(list: CdpTargetInfo[]): CdpTargetInfo[]`; `function findWindowChromeTarget(list: CdpTargetInfo[]): CdpTargetInfo | undefined`
  - `type Visibility = 'visible' | 'hidden' | 'unknown'`; `function pickChartTarget(candidates: CdpTargetInfo[], visibility: ReadonlyMap<string, Visibility>): CdpTargetInfo`

- [ ] **Step 1: Write the failing tests.**
  - `classifies the observed macOS target list`: on `targets.macos-3.4.1.json`, exactly one `chart`, one `window-chrome`, three `helper`, two `blank`; iframes and workers are `other`.
  - `pickChartTarget returns the sole candidate without visibility data`.
  - `pickChartTarget prefers the visible target`.
  - `pickChartTarget throws TARGET_NOT_FOUND when no chart target exists`, with a hint mentioning opening a chart tab.
  - `pickChartTarget throws TARGET_NOT_FOUND listing tabs when several are visible or none is`.
  - Integration: `discovery lists targets from a running endpoint`; `discovery maps connection refused to CDP_UNREACHABLE` (closed port; hint mentions `app_launch`); `discovery times out on a stalled endpoint`.
- [ ] **Step 2: Run the tests to verify they fail.** Run: `pnpm -C packages/server vitest run test/unit/core/cdp test/integration/cdp-discovery.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Chart rule: `type === 'page'` and URL matching `^https://([a-z0-9-]+\.)?tradingview\.com/chart/`. Window chrome: `type === 'page'` and a `file://` URL containing `/app/window/index.html`. Blank: `type === 'page'` with an empty URL. Discovery uses `fetch` with `AbortSignal.timeout`.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(cdp): discover CDP targets and classify TradingView renderers"`

---

### Task 7: CDP session adapter on chrome-remote-interface

**Files:**

- Create: `src/core/cdp/cri-connector.ts` (and add `CdpSession`, `CdpConnector` to `src/core/cdp/types.ts`)
- Test: `test/integration/cri-connector.test.ts`

**Interfaces:**

- Consumes: `CdpTargetInfo` (Task 6), `withTimeout` (Task 4), fake CDP server (Task 5).
- Produces:
  - `interface CdpSession { readonly targetId: string; readonly isClosed: boolean; send<M extends keyof ProtocolMapping.Commands>(method: M, params?: ProtocolMapping.Commands[M]['paramsType'][0], options?: { timeoutMs?: number }): Promise<ProtocolMapping.Commands[M]['returnType']>; onClose(listener: () => void): void; close(): Promise<void> }`
  - `interface CdpConnector { connect(target: CdpTargetInfo): Promise<CdpSession> }`; `function createCriConnector(options: { host: string; port: number; defaultTimeoutMs: number }): CdpConnector`

- [ ] **Step 1: Write the failing tests.**
  - `sends a command and resolves its result`: `Runtime.evaluate` of `1 + 1` returns `{ result: { type: 'number', value: 2 } }`.
  - `rejects with TIMEOUT when the target never answers`: `silent` target with `timeoutMs: 300`.
  - `marks the session closed when the server drops the connection`: after `dropConnections()`, `isClosed` is `true` and `onClose` listeners ran once.
- [ ] **Step 2: Run the tests to verify they fail.** Run: `pnpm -C packages/server vitest run test/integration/cri-connector.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with `CDP({ host, port, target: target.id, local: true })` (`local: true` uses the bundled protocol descriptor instead of fetching one from the app), wrapping each `send` in `withTimeout`. Map the CRI `disconnect` event to `isClosed` and the close listeners.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(cdp): add chrome-remote-interface session adapter with per-call timeouts"`

---

### Task 8: Page bridge, TvWindow contract, and serializability guard

**Files:**

- Create: `src/core/tv/tv-window.ts`, `src/core/tv/page-bridge.ts`, `src/core/tv/page-functions.ts` (registry of all page functions, used only by the guard test)
- Test: `test/unit/core/tv/page-bridge.test.ts`, `test/unit/core/tv/page-functions.serializable.test.ts`, `test/integration/page-bridge.test.ts`

**Interfaces:**

- Consumes: `CdpSession` (Task 7), errors (Task 2).
- Produces:
  - `TvWindow` and nested interfaces (`TradingViewApiLike`, `ChartWidgetApiLike`, `StudyApiLike`, `ChartWidgetLike`, `ChartModelLike`, `SeriesLike`, `BarsLike`, `TimeScaleLike`, `TvdLike`), covering exactly the members from reverse-engineering §4.2 to §4.4. All are optional at the top level (`TradingViewApi?`), because the page may not be ready.
  - `interface PageErrorSentinel { __tvmcpError: { code: ErrorCode; message: string; hint?: string; details?: JsonObject } }`; `function isPageErrorSentinel(v: unknown): v is PageErrorSentinel`
  - `type PageFunction<A extends JsonValue[], R extends JsonValue | null> = (win: TvWindow, ...args: A) => R | PageErrorSentinel | Promise<R | PageErrorSentinel>`
  - `interface PageBridge { evaluate<A extends JsonValue[], R extends JsonValue | null>(fn: PageFunction<A, R>, args: A, options?: { timeoutMs?: number }): Promise<R> }`; `function createPageBridge(session: CdpSession, defaults: { timeoutMs: number }): PageBridge`
  - `export const pageFunctions: Record<string, (...args: never[]) => unknown>` in `page-functions.ts` (every domain's `page.ts` adds its exports here)

- [ ] **Step 1: Write the failing tests.**
  - `builds an expression that calls the function with window and JSON args`: a fake session records `params.expression === '(' + fn.toString() + ')(window, ...[1,"a"])'`, with `returnByValue: true` and `awaitPromise: true`.
  - `maps exceptionDetails to PAGE_EVALUATION_FAILED` with the first line of `exception.description` as the message.
  - `maps a PLAN_LIMIT sentinel to PlanLimitError`, and other sentinel codes to `TvMcpError` with the same code.
  - Guard: `every page function serializes without bundler helpers or imports`: for each entry in `pageFunctions`, `fn.toString()` does not match `/\b(require|import)\s*\(|__name|__async|__publicField|__spreadValues/`.
  - Guard: `every page function runs in an isolated vm context`: run in `vm.runInNewContext` with a fake window from Task 5; no `ReferenceError`.
  - Integration: `evaluates a page function against the fake CDP page`; `times out on silent targets`.
- [ ] **Step 2: Run the tests to verify they fail.** Run: `pnpm -C packages/server vitest run test/unit/core/tv test/integration/page-bridge.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the bridge and the `TvWindow` interfaces.** Page functions must avoid classes and top-level helpers; `tsup` targets `node20` (ES2022), so async functions and optional chaining stay native.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(tv): add page bridge with typed TradingView window contract"`

---

### Task 9: Input helpers and the unsafe-target guard

**Files:**

- Create: `src/core/tv/selectors.ts`, `src/core/tv/input.ts`
- Test: `test/unit/core/tv/input.test.ts`, `test/integration/input.test.ts`

**Interfaces:**

- Consumes: `PageHandle` shape `{ session: CdpSession; bridge: PageBridge }` (formally defined in Task 10; use a local structural type here).
- Produces:
  - `export const SELECTORS` (reverse-engineering §5.1 to §5.6, keyed by purpose, for example `SELECTORS.header.symbolSearch = '#header-toolbar-symbol-search'`)
  - `export const UNSAFE_SELECTORS: readonly string[]` (reverse-engineering §5.5)
  - Page function `describeElement(win: TvWindow, selector: string): { found: boolean; visible: boolean; unsafe: boolean; rect?: { x: number; y: number; width: number; height: number } }` (`unsafe` is true when the element matches, contains, or sits inside an unsafe selector)
  - `function clickElement(page: { session: CdpSession; bridge: PageBridge }, selector: string): Promise<void>` (throws `UNSAFE_ACTION_BLOCKED` for unsafe targets, and `NOT_AVAILABLE` when missing or invisible); `function typeText(page, text: string): Promise<void>` (`Input.insertText`); `function pressKey(page, key: string, modifiers?: ('Alt' | 'Control' | 'Meta' | 'Shift')[]): Promise<void>` (`Input.dispatchKeyEvent` `keyDown` then `keyUp`, with correct `code`, `key`, and `windowsVirtualKeyCode` for Enter, Escape, Tab, arrows, letters, and digits)

- [ ] **Step 1: Write the failing tests.**
  - `describeElement flags the buy order button as unsafe` (a fake DOM via a minimal `document.querySelector` stub).
  - `clickElement refuses unsafe targets with UNSAFE_ACTION_BLOCKED` and sends no `Input` call.
  - `clickElement dispatches press and release at the element center`: recorded `Input.dispatchMouseEvent` calls are `mousePressed` then `mouseReleased` at `rect` center.
  - `pressKey sends keyDown and keyUp with Enter's key codes` (`windowsVirtualKeyCode 13`).
- [ ] **Step 2: Run the tests to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(tv): add CDP input helpers with an unsafe-target guard"`

---

### Task 10: Connection manager and health

**Files:**

- Create: `src/core/connection.ts`
- Test: `test/integration/connection.test.ts`

**Interfaces:**

- Consumes: Tasks 6 to 8; `retry` (Task 4).
- Produces:
  - `interface PageHandle { target: CdpTargetInfo; session: CdpSession; bridge: PageBridge }`
  - `interface HealthReport { cdp: { reachable: boolean; endpoint: string; browser?: string; userAgent?: string }; chart: { found: boolean; tabs: number; url?: string }; app: { ready: boolean; connected?: boolean; buildTime?: string | null } }`
  - `class ConnectionManager { constructor(deps: { discovery: CdpDiscovery; connector: CdpConnector; logger: Logger; callTimeoutMs: number; endpoint: string }); targets(): Promise<CdpTargetInfo[]>; chartPage(): Promise<PageHandle>; windowChromePage(): Promise<PageHandle>; health(): Promise<HealthReport>; reset(): Promise<void>; close(): Promise<void> }`

- [ ] **Step 1: Write the failing tests** (fake CDP server):
  - `connects to the chart target and reuses the session`: two `chartPage()` calls give the same session, and the server saw one WebSocket connection.
  - `re-resolves after the target disappears`: after `setTargets([...newTarget])` and `dropConnections()`, `chartPage()` returns the new target ID.
  - `selects the visible tab when two chart targets exist`: one fake window `hidden`, one `visible`.
  - `skips blank targets that never answer`: a `silent` blank target does not delay `chartPage()` beyond 2 s.
  - `health reports cdp unreachable within timeout`: closed port gives `cdp.reachable false` in under `callTimeoutMs`.
  - `health reports the app ready when TradingViewApi.isConnected() is true`.
  - `health reports not ready when TradingViewApi is missing`: fake window with `withoutApi`.
- [ ] **Step 2: Run the tests to verify they fail.** Run: `pnpm -C packages/server vitest run test/integration/connection.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Visibility is probed only when there is more than one chart candidate (`document.visibilityState` through the bridge, 1500 ms each, in parallel). Connection attempts retry 3 times for `CDP_UNREACHABLE` only. Cached sessions are dropped when closed or when their target leaves the list.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(core): add connection manager with tab selection and health report"`

---

### Task 11: Install discovery, process control, and launcher

**Files:**

- Create: `src/core/launcher/install.ts`, `src/core/launcher/process.ts`, `src/core/launcher/launch.ts`
- Test: `test/unit/core/launcher/install.test.ts`, `test/unit/core/launcher/launch.test.ts`

**Interfaces:**

- Consumes: `ConnectionManager.health()` (Task 10), `TvMcpError` (Task 2), `sleep` (Task 4).
- Produces:
  - `interface InstallDeps { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; exists(path: string): boolean; execFile(cmd: string, args: string[], options?: { timeoutMs?: number }): Promise<string> }`
  - `function installCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[]`; `function findInstall(deps: InstallDeps, overridePath?: string): Promise<string | null>`
  - `function isTradingViewRunning(deps: InstallDeps): Promise<boolean>`; `function quitTradingView(deps: InstallDeps, timeoutMs: number): Promise<void>`
  - `function buildLaunchArgs(port: number): string[]` (returns exactly `['--remote-debugging-port=<port>']`)
  - `interface LaunchResult { status: 'already-running' | 'launched' | 'restarted'; executable: string | null; endpoint: string; waitedMs: number }`
  - `interface Launcher { launch(options: { restart: boolean; port?: number }): Promise<LaunchResult>; discover(): Promise<{ executable: string | null; running: boolean; cdpReachable: boolean }> }`; `function createLauncher(deps: { install: InstallDeps; spawn: (cmd: string, args: string[]) => { pid?: number }; health: () => Promise<HealthReport>; config: Config; sleep?: (ms: number) => Promise<void> }): Launcher`

- [ ] **Step 1: Write the failing tests.**
  - `lists macOS candidates`: `['/Applications/TradingView.app/Contents/MacOS/TradingView', '<HOME>/Applications/TradingView.app/Contents/MacOS/TradingView']`.
  - `lists Windows candidates`: `%LOCALAPPDATA%\TradingView\TradingView.exe`, `%ProgramFiles%\TradingView\TradingView.exe`.
  - `lists Linux candidates`: `/opt/TradingView/tradingview`, `/usr/bin/tradingview`, `/snap/bin/tradingview`.
  - `TV_APP_PATH overrides detection` when the file exists, and gives `TV_NOT_INSTALLED` when it does not.
  - `resolves an MSIX install through Get-AppxPackage`: `execFile` returns `C:\Program Files\WindowsApps\TradingView.Desktop_1.0_x64__abc`, so the result ends with `\TradingView.exe`.
  - `buildLaunchArgs passes only the debug port`: equals `['--remote-debugging-port=9222']`, and contains neither `--options=clean` nor `--remote-debugging-address`.
  - `returns already-running without spawning when CDP is up`.
  - `running without CDP and restart=false throws RESTART_REQUIRED`, with a hint naming `restart: true`.
  - `restart quits, then spawns, then waits for readiness`: call order is `quit` → `spawn` → `health` until `app.ready`.
  - `fails with LAUNCH_FAILED when CDP never comes up` (fake sleep; `launchTimeoutMs` exceeded).
- [ ] **Step 2: Run the tests to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** Running-process detection: `pgrep -x TradingView` (macOS), `tasklist /FI "IMAGENAME eq TradingView.exe"` (Windows), `pgrep -f -i tradingview` (Linux). Graceful quit: `osascript -e 'quit app "TradingView"'`, `taskkill /IM TradingView.exe`, `pkill -TERM -f -i tradingview`, polling until stopped or timeout. Spawn detached with `stdio: 'ignore'` and `unref()`.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(launcher): detect TradingView installs and launch with the debug port"`

---

### Task 12: Tier runner and capability probe

**Files:**

- Create: `src/core/tv/tiers.ts`, `src/core/tv/capabilities.ts`
- Test: `test/unit/core/tv/tiers.test.ts`, `test/unit/core/tv/capabilities.test.ts`

**Interfaces:**

- Consumes: errors (Task 2), `PageFunction` (Task 8), fake window (Task 5).
- Produces:
  - `interface Strategy<T> { tier: Tier; name: string; run(): Promise<T> }`; `function runWithFallback<T>(strategies: Strategy<T>[], logger: Logger): Promise<{ value: T; via: Tier }>`
  - `interface Capabilities { tradingViewApi: boolean; activeChart: boolean; chartModel: boolean; replayApi: boolean; pineEditorApi: boolean; webpackRegistry: boolean; tvd: boolean; buildTime: string | null }`; page function `probeCapabilities(win: TvWindow): Capabilities`

- [ ] **Step 1: Write the failing tests.**
  - `returns the first strategy that succeeds and reports its tier`.
  - `falls through only on CAPABILITY_UNAVAILABLE`.
  - `stops on any other error without running later strategies`: `PLAN_LIMIT` from the first strategy rejects, and the second never runs.
  - `aggregates attempts when every strategy is unavailable`: the final `CAPABILITY_UNAVAILABLE` error has `details.attempts` listing the names in order.
  - `probeCapabilities reports features of the fake window`, and `probeCapabilities reports false for a window without TradingViewApi`.
- [ ] **Step 2: Run the tests to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** `webpackRegistry` is `Array.isArray(win.webpackChunktradingview)`; the probe never pushes a chunk.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(tv): add tiered fallback runner and capability probe"`

---

### Task 13: Tool registry, MCP server factory, `batch_run`, and resources framework

**Files:**

- Create: `src/tools/types.ts`, `src/tools/registry.ts`, `src/tools/index.ts` (`export const allTools: AnyToolDefinition[]`, starting with `batchTools`), `src/tools/batch/index.ts`, `src/resources/index.ts`, `src/server.ts`
- Modify: `src/index.ts` (export `createMcpServer`, `loadConfig`, and public types)
- Test: `test/unit/tools/registry.test.ts`, `test/integration/server.test.ts`, `test/helpers/mcp-client.ts`

**Interfaces:**

- Consumes: Tasks 2, 3, 10, 11, 12.
- Produces:
  - `type Domain` (spec §5.1 prefixes without the underscore)
  - `interface SessionState { createdDrawingIds: Set<string>; createdAlertIds: Set<string> }`
  - `interface ToolContext { config: Config; logger: Logger; connection: ConnectionManager; launcher: Launcher; events: ToolEventBus; session: SessionState }`
  - `interface ToolOutput<T extends JsonValue> { data: T; via?: Tier; warnings?: string[]; images?: ImageContent[] }`
  - `interface ToolDefinition<S extends z.ZodRawShape, T extends JsonValue> { name: string; domain: Domain; title: string; description: string; inputSchema: S; annotations: ToolAnnotations; core?: boolean; handler(input: z.output<z.ZodObject<S>>, ctx: ToolContext): Promise<ToolOutput<T>> }`; `function defineTool<S extends z.ZodRawShape, T extends JsonValue>(def: ToolDefinition<S, T>): ToolDefinition<S, T>`; `type AnyToolDefinition = ToolDefinition<z.ZodRawShape, JsonValue>`
  - `function selectTools(tools: AnyToolDefinition[], options: { profile: Profile; patterns: string[] }): AnyToolDefinition[]` (`core` keeps `core: true` tools; `readonly` keeps `annotations.readOnlyHint === true`; patterns support `*`)
  - `interface ToolRegistry { list(): AnyToolDefinition[]; call(name: string, args: unknown, origin: ToolCallEvent['origin']): Promise<CallToolResult> }`; `function createToolRegistry(tools: AnyToolDefinition[], ctx: ToolContext): ToolRegistry`
  - `function registerToolsWithServer(server: McpServer, registry: ToolRegistry): void`
  - `function registerResources(server: McpServer, ctx: ToolContext): void` (Plan 1 registers `tradingview://app/health`; Task 16 adds `tradingview://chart/state`)
  - `interface ServerDeps { connection: ConnectionManager; launcher: Launcher; logger: Logger; events: ToolEventBus }`; `function createMcpServer(config: Config, deps?: Partial<ServerDeps>): { server: McpServer; registry: ToolRegistry; ctx: ToolContext }`
  - Test helper `connectInMemoryClient(server: McpServer): Promise<Client>`

- [ ] **Step 1: Write the failing tests.**
  - Unit: `selectTools applies the readonly profile`, `selectTools applies glob patterns`, `selectTools core profile keeps core tools only`.
  - Unit: `registry wraps results in the envelope with durationMs`, `registry maps thrown TvMcpError to an error result`, `registry rejects unknown tools with INVALID_INPUT`, `registry emits start and end events with the error code`, `registry truncates long string arguments in events to 200 characters`.
  - Integration (in-memory client): `lists registered tools with descriptions and input schemas`; `invalid input returns a validation error result`; `batch_run executes steps in order and stops on the first error` (two fake tools; the second fails; the third never runs; the result lists per-step outcomes); `batch_run rejects nested batch_run with INVALID_INPUT`; `batch_run limits steps to 20`; `reads the app health resource`.
- [ ] **Step 2: Run the tests to verify they fail.** Run: `pnpm -C packages/server vitest run test/unit/tools test/integration/server.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Use `McpServer.registerTool(name, { title, description, inputSchema, annotations }, cb)` and `McpServer.registerResource`, confirming signatures against the installed SDK version. `registry.call` validates with `z.object(shape).safeParse` so batch and dashboard calls get the same validation as MCP calls. `batch_run` input: `steps: z.array(z.object({ tool: z.string(), arguments: z.record(z.string(), z.unknown()).default({}) })).min(1).max(20)`, `stopOnError: z.boolean().default(true)`.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(server): add tool registry, batch_run and resource framework"`

---

### Task 14: Transports and CLI

**Files:**

- Create: `src/transports/stdio.ts`, `src/transports/http.ts`, `src/transports/http-security.ts`, `src/cli.ts`, `src/cli/banner.ts`
- Test: `test/unit/transports/http-security.test.ts`, `test/integration/stdio.test.ts`, `test/integration/http.test.ts`

**Interfaces:**

- Consumes: `createMcpServer` (Task 13), `loadConfig` (Task 3), `createLogger` (Task 2), launcher and connection (Tasks 10 and 11).
- Produces:
  - `function startStdioTransport(server: McpServer): Promise<void>`
  - `interface HttpServerHandle { url: string; port: number; close(): Promise<void> }`; `function startHttpTransport(options: { config: Config; createServer: () => McpServer; logger: Logger; dashboardDir?: string }): Promise<HttpServerHandle>` (routes `POST|GET|DELETE /mcp` and `/mcp/<token>`, plus `GET /healthz`; `/api/*` and static dashboard files arrive in Plan 4)
  - `function tokenMatches(provided: string | undefined, expected: string): boolean` (constant-time); `function isAllowedOrigin(origin: string | undefined, allowedHosts: string[]): boolean`; `function isAllowedHost(host: string | undefined, allowedHosts: string[]): boolean`
  - `function renderBanner(info: { version: string; transport: string; endpoint?: string; cdp: string }): string`
  - CLI: `serve` (default), `launch`, and `doctor`. `config <client>` arrives in Plan 5 and prints `Not implemented yet` with exit code 2 until then.

- [ ] **Step 1: Write the failing tests.**
  - Unit: `tokenMatches compares in constant time and rejects length mismatches`; `isAllowedOrigin accepts missing and loopback origins and rejects foreign ones`; `isAllowedHost rejects rebinding hosts like evil.example:8787`.
  - Integration stdio (spawn `node dist/cli.js` after `pnpm build`, with `TV_CDP_PORT` pointing at the fake CDP server): `stdio client lists tools and calls app_health`; **`stdio stdout carries only JSON-RPC`** (every stdout line parses as JSON with `jsonrpc === '2.0'`; the banner appears on stderr).
  - Integration HTTP (port 0, token `test-token`): `rejects requests without a token with 401`; `rejects a foreign Origin with 403`; `accepts the token as a Bearer header`; `accepts the token as a path segment`; `serves /healthz without a token`; `client lists tools over Streamable HTTP`.
- [ ] **Step 2: Run the tests to verify they fail.** Run: `pnpm build && pnpm -C packages/server vitest run test/unit/transports test/integration/stdio.test.ts test/integration/http.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** HTTP uses `StreamableHTTPServerTransport` with `sessionIdGenerator: randomUUID` and a session map with a 30-minute idle timeout. Allowed hosts are `127.0.0.1`, `localhost`, and the configured host. `cli.ts` starts with `#!/usr/bin/env node`, prints the banner to stderr, and shuts down cleanly on `SIGINT` and `SIGTERM`. `launch` calls `Launcher.launch({ restart: false })` and prints the result. `doctor` prints `ConnectionManager.health()` as a readable checklist. Fatal errors print the `TvMcpError` code, message, and hint in color on stderr and exit with code 1.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(transports): add stdio and Streamable HTTP transports with token auth and CLI"`

---

### Task 15: App domain tools

**Files:**

- Create: `src/tools/app/index.ts`, `src/tools/app/page.ts`
- Modify: `src/tools/index.ts` (aggregate `allTools`), `src/core/tv/page-functions.ts`
- Test: `test/unit/tools/app/page.test.ts`, `test/integration/tools/app.test.ts`

**Interfaces:**

- Consumes: `defineTool`, `ToolContext` (Task 13); `Launcher` (Task 11); `ConnectionManager` (Task 10); `probeCapabilities` (Task 12); `SELECTORS` (Task 9).
- Produces: `export const appTools` with `app_launch`, `app_health`, `app_discover`, `app_get_ui_state`, `app_reconnect` (inputs as in spec §7); page functions `readAppInfo(win): { buildTime: string | null; connected: boolean; layoutType: string | null; url: string }` and `readUiState(win): { rightPanel: { open: boolean; activeWidget: string | null }; bottomPanelOpen: boolean; dialogs: string[]; fullscreen: boolean; replayToolbarVisible: boolean; pineEditorOpen: boolean }`.

- [ ] **Step 1: Write the failing tests.**
  - Unit: `readUiState reports open dialogs from #overlap-manager-root`; `readAppInfo returns BUILD_TIME and the connection flag`.
  - Integration: `app_health returns cdp, chart and app sections`; `app_health returns CDP_UNREACHABLE as data when TradingView is down` (health is a report, so it succeeds with `cdp.reachable false`); `app_launch maps RESTART_REQUIRED to an error result`; `app_discover lists classified targets`; `app_reconnect drops cached sessions`; `app_reconnect with reloadTab calls TVD.reloadTab`.
- [ ] **Step 2: Run the tests to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** `app_launch` has annotations `{ readOnlyHint: false, destructiveHint: false }`, and its description states that `restart: true` closes and reopens TradingView. All app tools are `core: true`.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(app): add launch, health, discover, UI state and reconnect tools"`

---

### Task 16: Chart domain tools and chart state resource

**Files:**

- Create: `src/tools/chart/index.ts`, `src/tools/chart/page.ts`, `src/tools/chart/mappers.ts`
- Modify: `src/tools/index.ts`, `src/resources/index.ts`, `src/core/tv/page-functions.ts`
- Test: `test/unit/tools/chart/mappers.test.ts`, `test/unit/tools/chart/page.test.ts`, `test/integration/tools/chart.test.ts`

**Interfaces:**

- Consumes: Tasks 4, 8, 9, 10, 12, 13.
- Produces:
  - `function normalizeTimeframe(input: string): string` (aliases: `1m`/`1min` → `1`, `15m` → `15`, `1h` → `60`, `4h` → `240`, `1d`/`D` → `1D`, `1w` → `1W`, `1M` → `1M`, `30s` → `30S`, `100T`, `1000R`; anything else is `INVALID_INPUT` listing accepted forms)
  - `export const CHART_TYPES` (an `as const` object) with `bars 0, candles 1, line 2, area 3, renko 4, kagi 5, point_and_figure 6, line_break 7, heikin_ashi 8, hollow_candles 9, baseline 10, high_low 12, columns 13, line_with_markers 14, step_line 15, hlc_area 16`; `type ChartTypeName = keyof typeof CHART_TYPES`; `function chartTypeName(id: number): ChartTypeName | 'unknown'`. The E2E suite confirms at least `candles`, `line`, and `heikin_ashi` against the real app.
  - Page functions: `readChartState(win, chartIndex: number | null)`, `setSymbolViaApi(win, symbol: string, chartIndex: number | null, timeoutMs: number)` (resolves after `dataReady`, or returns an `INVALID_INPUT` sentinel when `isSymbolInvalid()` turns true), `setResolutionViaApi(win, resolution, chartIndex, timeoutMs)`, `setChartTypeViaApi(win, typeId, chartIndex)`, `readVisibleRange(win, chartIndex)`, `zoomToTimeRange(win, from: number, to: number, chartIndex)` (maps times to bar indices with `bars().search` or `timeScale().timePointToIndex`, then calls `zoomToBarsRange`), `scrollToTime(win, time: number, align: 'left' | 'center' | 'right', chartIndex)`
  - `export const chartTools` with the 7 chart tools from spec §7 (all `core: true`); T3 fallbacks for symbol (symbol search dialog plus `typeText` plus Enter), timeframe (`#header-toolbar-intervals`), and visible-range presets (`[data-name="date-range-tab-<preset>"]`).

- [ ] **Step 1: Write the failing tests.**
  - Unit mappers: a table test `normalizeTimeframe maps documented aliases` over every alias above; `normalizeTimeframe distinguishes minutes from months` (`1m` → `1`, `1M` → `1M`); `normalizeTimeframe rejects 7x with INVALID_INPUT`; `chartTypeName round-trips CHART_TYPES`.
  - Unit page functions (fake window): `readChartState returns symbol, resolution, type name, range, studies, shapes count and layout`; `zoomToTimeRange calls zoomToBarsRange with indices of the nearest bars`; `zoomToTimeRange clamps to loaded history and returns a warning`; `scrollToTime centers the bar`.
  - Integration: `chart_get_state returns the fixture state`; `chart_set_symbol switches symbol via api`; **`chart_set_symbol rejects an unknown symbol`** (`INVALID_INPUT`, and the details show the chart kept `NASDAQ:AAPL`); `chart_set_timeframe normalizes 1h to 60`; `chart_set_type sets heikin_ashi (8)`; `chart_set_visible_range uses the internal time scale because setVisibleRange is not implemented` (`meta.via === 'internal'`); `chart_scroll_to_date accepts ISO and Unix inputs`; `reads the chart state resource`.
- [ ] **Step 2: Run the tests to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** Handlers parse times with `parseTimeInput`, validate `chartIndex` against `chartsCount()`, and run strategies through `runWithFallback`.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(chart): add chart state, symbol, timeframe, type and range tools"`

---

### Task 17: E2E harness, reverse-engineering probes, fixture recorder, and testing docs

**Files:**

- Create: `test/e2e/setup.ts`, `test/e2e/app.e2e.test.ts`, `test/e2e/chart.e2e.test.ts`
- Create: `scripts/re/probe.ts`, `scripts/re/record-fixtures.ts`, `scripts/re/scrub.ts`, `scripts/re/README.md`
- Create: `docs/testing.md`
- Test: `test/unit/scripts/scrub.test.ts`

**Interfaces:**

- Consumes: `createMcpServer`, `connectInMemoryClient`, page functions.
- Produces:
  - `function e2eEnabled(): boolean` (`process.env.TV_E2E === '1'`); `interface ChartSnapshot { symbol: string; resolution: string; chartType: number; visibleRange: { from: number; to: number } }`; `function snapshotChart(client: Client): Promise<ChartSnapshot>`; `function restoreChart(client: Client, snapshot: ChartSnapshot): Promise<void>` (plan-limit-aware skipping arrives in Plan 2 together with the plan limits module)
  - `function scrubFixture(raw: JsonObject): JsonObject` (replaces layout name and ID, strips drawing text, removes account fields, and swaps recorded prices for `syntheticBars` with a fixed seed)
  - Root scripts `re:probe` and `re:record`

- [ ] **Step 1: Write the failing test** `scrubFixture removes personal data and real prices`: the input carries layout name `My Layout`, ID `abc123`, a drawing text `entry 705`, and real bars; the output has `Fixture Layout`, `FIXTURE1`, no drawing text, and bars equal to `syntheticBars` for the fixture seed.
- [ ] **Step 2: Run the test to verify it fails.** Expected: FAIL.
- [ ] **Step 3: Implement the scrubber, probe, and recorder.** `probe.ts` runs the read-only introspection snippets from reverse-engineering §14 and prints a summary. `record-fixtures.ts` captures through the domain page functions and writes scrubbed JSON into `test/fixtures/tv/`.
- [ ] **Step 4: Run the test to verify it passes.** Expected: PASS.
- [ ] **Step 5: Write the E2E suites.** `app.e2e.test.ts`: `app_health reports a ready app`, `app_discover finds the chart target`. `chart.e2e.test.ts` snapshots in `beforeAll` and restores in `afterAll`: `switches symbol and timeframe, then restores them`; `changes chart type and restores it`; `sets and restores the visible range`. Each test file starts with `describe.skipIf(!e2eEnabled())`.
- [ ] **Step 6: Write `docs/testing.md`.** Cover how to run each level, how to record fixtures (`pnpm re:record`), the synthetic-price rule, and the E2E safety rules from spec §10.
- [ ] **Step 7: Verify against real TradingView.** Run: `TV_E2E=1 pnpm test:e2e`. Expected: PASS, and the chart ends in its original state (symbol, timeframe, type, range).
- [ ] **Step 8: Commit.** `git commit -m "test: add E2E harness, reverse-engineering probes and fixture recorder"`

---

### Task 18: CI workflow, README stub, and first push

**Files:**

- Create: `.github/workflows/ci.yml`, `README.md` (stub with badges and a "work in progress" note), `CONTRIBUTING.md` (commit conventions and local setup), `SECURITY.md`
- Create: `scripts/smoke-node20.mjs` (spawns the built CLI with `--transport stdio`, sends `initialize` and `tools/list`, and asserts that `app_health` is listed)

**Interfaces:**

- Consumes: root scripts (Task 1) and the built CLI (Task 14).

- [ ] **Step 1: Write the workflow.** Job `verify` on `ubuntu-latest` with Node 24: checkout → `pnpm/action-setup` → `actions/setup-node` with pnpm cache → `pnpm install --frozen-lockfile` → `pnpm lint` → `pnpm typecheck` → `pnpm test:unit` → `pnpm test:integration` → `pnpm test:coverage` (fails under 80%) → `pnpm build` → upload `packages/server/dist` and the coverage report. Job `runtime-node20` needs `verify`: download `dist`, set up Node 20, `npm install --omit=dev` inside `packages/server`, then `node scripts/smoke-node20.mjs`. Triggers: `push` and `pull_request`.
- [ ] **Step 2: Run the smoke script locally.** Run: `pnpm build && node scripts/smoke-node20.mjs`. Expected: prints `smoke ok`.
- [ ] **Step 3: Run the full local gate.** Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm test:coverage && pnpm build`. Expected: all pass, with coverage ≥80% on every metric.
- [ ] **Step 4: Commit.** `git commit -m "ci: add GitHub Actions workflow with coverage gate and Node 20 runtime smoke test"`
- [ ] **Step 5: Push to `main`** (Phase 2 stable). Run: `git push -u origin main`. Expected: the CI run on GitHub passes.
