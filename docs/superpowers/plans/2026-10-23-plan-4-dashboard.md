# Plan 4: Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a web dashboard, served by the server, where the user watches every tool call live, sees whether
TradingView is connected, browses the tools of the running profile, and runs a tool by hand.

**Architecture:**

- The server's `node:http` transport gains a token-protected dashboard API under `/api/*`, with Server-Sent Events
  for the tool-event log, and serves the built dashboard's static files at `/`.
- `packages/dashboard` is a private React app (Vite, Tailwind, shadcn/ui). Its build is copied into
  `packages/server/dist/dashboard`, so the published package carries it.
- Tools run from the dashboard go through the same registry as MCP calls, with `origin: 'dashboard'`: validation,
  plan limits, `confirm` rules and events all apply.

**Tech Stack:**

- Server: TypeScript 6, `node:http`, zod 4 `toJSONSchema`.
- Dashboard: React 19, Vite 8, Tailwind CSS 4 (`@tailwindcss/vite`), shadcn/ui (Radix, class-variance-authority,
  tailwind-merge, lucide-react), `@tanstack/react-query`, `wouter`.
- Tests: Vitest 5 with jsdom, React Testing Library, MSW 2 and Playwright.

**Spec:** `docs/superpowers/specs/2026-10-18-tradingview-mcp-design.md`: §2, §3, §8 (dashboard, transports, security),
§9 (`TV_MCP_DASHBOARD`), §10 (dashboard unit and E2E rows), §11 (CI order), §12 (Plan 4).

## Global Constraints

- TypeScript strict, no `any`, ESM. English only in code, comments, test names, UI text, logs and docs.
- Commits: Conventional Commits, local git identity, **no AI attribution of any kind**.
- No personal data in committed files. Fixtures, mock servers and screenshots use synthetic values.
- Code and comments never cite controller rulings or the SDD ledger.
- The server package keeps `engines.node >=20.19` and gains **no new runtime dependency**. Dashboard code is
  build-time only. `packages/dashboard` is `private: true`, and every dependency in it is a devDependency.
- **HTTP defaults:** `127.0.0.1:8787`. A token is required (`TV_MCP_AUTH_TOKEN`), as `Authorization: Bearer
<token>`. `Host` and `Origin` are validated against the existing allowlist on every route.
- **Unauthenticated routes:** `/healthz` and the static dashboard files only. Every `/api/*` route needs the token.
- **The token is never printed or logged:** not in the banner, logs, events, error bodies or URLs the server writes.
- **`TV_MCP_DASHBOARD`:** default on in HTTP mode, off in stdio mode.
  - `--dashboard` next to stdio starts a separate listener on `httpHost:httpPort` that serves the dashboard and
    `/api/*` only (no `/mcp`).
  - It needs `TV_MCP_AUTH_TOKEN`. Without it, or when the port is taken, the dashboard is disabled with a warning,
    and the MCP server runs on.
- **Dashboard tool calls** use one dedicated registry per process (`createMcpServer(config, deps).registry`) and
  `origin: 'dashboard'`. Nothing in the dashboard path bypasses the registry.
- **Tool events** keep their redaction (`src/tools/redaction.ts`). The dashboard shows exactly what the bus holds.
- **No request leaves the machine:** no CDN, web font or analytics. The dashboard's CSP allows `'self'` only, plus
  `data:` images and inline styles (Radix).
- **Coverage:**
  - ≥80% lines, branches, functions and statements over `packages/server/src`. Keep it near today's 99.8%.
  - ≥80% over `packages/dashboard/src`, excluding the vendored `src/components/ui/**`.
- **Commands:**
  - Root gate: `pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm test:coverage`.
  - Dashboard E2E: `pnpm --filter tradingview-desktop-mcp-dashboard test:e2e`.

## Review Focus

Each line below names a likely failure mode and the behaviour a user would expect. Each has a test in the task named
in brackets.

1. **Messy pasted token.** A token pasted with spaces or a newline, or a wrong token, gets a clear message and the
   token screen again, never a blank page. The token is trimmed. A 401 from any call returns to the token screen.
   [Task 5]
2. **Server restart or dropped connection while the dashboard is open.** The live log shows "Reconnecting", retries
   with backoff, resumes with `Last-Event-ID` without duplicating calls, and says when events were missed. A 401
   after the restart returns to the token screen. [Tasks 1, 5]
3. **A chatty client or a slow browser tab.** Hundreds of calls a minute must not slow tool calls. The server closes
   an SSE stream whose unsent buffer passes 1 MiB, and the bus never blocks. The browser keeps at most 1000 calls and
   stays responsive. [Tasks 1, 5]
4. **A huge result** (a several-MB screenshot, 5000 OHLCV bars). Images render. JSON longer than 20 000 characters is
   collapsed behind "Show all", and the page does not freeze. [Task 8]
5. **TradingView not running.** The status page shows "not reachable" with the `launch` hint. Health polling never
   overlaps (one request in flight at a time), and each check is bounded by the server's call timeout. [Tasks 5, 6]

---

### Task 1: Event sequence, SSE stream, tool schemas and the dashboard contract

**Files:**

- Modify: `packages/server/src/core/events.ts`, `packages/server/src/index.ts` (type exports)
- Create:
  - `packages/server/src/transports/dashboard/contract.ts` (types only, self-contained, no imports)
  - `packages/server/src/transports/dashboard/sse.ts`
  - `packages/server/src/tools/schema-export.ts`
- Test:
  - `packages/server/test/unit/core/events.test.ts` (extend)
  - `packages/server/test/unit/transports/dashboard/{sse,contract}.test.ts`
  - `packages/server/test/unit/tools/schema-export.test.ts`

**Interfaces:**

- Produces in `events.ts`:
  - `ToolCallEvent` gains `seq: number`, assigned by the bus: monotonic from 1 per bus.
  - `emit(e: Omit<ToolCallEvent, 'seq'>): ToolCallEvent` returns the stored event.
  - `after(seq: number, limit = 500): { events: ToolCallEvent[]; gap: boolean }` returns the buffered events with a
    larger `seq`, oldest first. `gap` is true when events after `seq` were already dropped from the buffer.
  - `recent()` and `subscribe()` are unchanged.
- Produces in `contract.ts`, plain JSON types that mirror the server types, with no imports:
  - `DashboardInfo { name: string; version: string; transport: 'stdio' | 'http'; profile: 'core' | 'full' | 'readonly';
toolPatterns: string[]; allowEval: boolean; toolCount: number; mcpEndpoint: string | null; startedAt: string }`
  - `DashboardHealth`: the shape of `HealthReport`.
  - `DashboardEvent`: the shape of `ToolCallEvent` including `seq`.
  - `DashboardTool { name; domain; title; description; annotations: { readOnlyHint: boolean; destructiveHint: boolean;
idempotentHint: boolean; openWorldHint: boolean }; core: boolean; profiles: ('core' | 'full' | 'readonly')[];
inputSchema: JsonSchemaObject }`
  - `DashboardToolList { tools: DashboardTool[] }`
  - `DashboardCallRequest { arguments?: Record<string, JsonValue> }`
  - `DashboardCallResult { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
structuredContent?: Record<string, JsonValue>; isError?: boolean }`
  - `DashboardError { error: string }`
  - Also `JsonValue` and `JsonSchemaObject = Record<string, JsonValue>`.
- Produces in `sse.ts`:
  - `formatSseEvent(event: string, data: JsonValue, id?: number): string` gives
    `id: <id>\nevent: <event>\ndata: <json>\n\n`, with the JSON on one line.
  - `class SseStream`, constructed as `new SseStream(res: ServerResponse, options?: { heartbeatMs?: number; maxBufferedBytes?: number })`:
    - `send(event, data, id?): boolean`
    - `close(): void`
    - `onClose(fn): void`
    - Defaults: `heartbeatMs` 15 000, `maxBufferedBytes` 1 048 576.
    - It writes the headers `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-store` and
      `X-Accel-Buffering: no`, then a first line `retry: 3000\n\n`.
    - The heartbeat is a comment line, `: ping\n\n`.
    - `send` closes the stream and returns false when `res.writableLength` exceeds `maxBufferedBytes`.
- Produces in `schema-export.ts`:
  - `toolInputJsonSchema(tool: AnyToolDefinition): JsonSchemaObject` is zod 4 `z.toJSONSchema(z.object(tool.inputSchema),
{ io: 'input', unrepresentable: 'any' })`, cached per tool.
  - `toolProfiles(tool): Profile[]` returns `full` always, `core` when `tool.core === true`, and `readonly` when
    `annotations.readOnlyHint === true`.
  - Move the profile predicate out of `registry.ts`, and have `selectTools` use `toolProfiles` too.

- [ ] **Step 1: Write the failing tests.**
  - `the bus numbers events from 1 and after() returns the newer ones oldest first`.
  - `after() reports a gap when the requested events were dropped from the buffer`. Emit 501 events, then
    `after(0).gap` is true.
  - `formatSseEvent writes one id, event and data line and a blank line`.
  - `SseStream sends a heartbeat comment every heartbeatMs`. Use fake timers.
  - `SseStream closes and refuses to send when the client's unsent buffer passes maxBufferedBytes`.
  - `toolInputJsonSchema describes every registered tool as an object schema with its descriptions`. Loop over
    `allTools`: `type: 'object'`, a `properties` key, and each property's `description` matches the zod `.describe()`.
  - `toolProfiles matches the profile selection of the registry for every tool`.
  - `the dashboard contract accepts the server's own types`. Use type-level assertions (`expectTypeOf`) that
    `HealthReport` is assignable to `DashboardHealth`, `ToolCallEvent` to `DashboardEvent`, and the SDK's
    `CallToolResult` text and image blocks to `DashboardCallResult`.
- [ ] **Step 2: Run them to verify they fail.**
      Run: `pnpm -C packages/server exec vitest run test/unit/core/events.test.ts test/unit/transports/dashboard test/unit/tools/schema-export.test.ts`.
      Expected: FAIL.
- [ ] **Step 3: Implement** with the signatures above. The registry emits through `emit` unchanged; only the bus adds
      `seq`.
- [ ] **Step 4: Run them to verify they pass,** then run the full server suite.
- [ ] **Step 5: Commit:** `feat(core): number tool events, stream them as server-sent events and describe tool inputs as JSON schema`.

---

### Task 2: Dashboard API

**Files:**

- Create: `packages/server/src/transports/dashboard/api.ts`, `packages/server/src/transports/dashboard/body.ts`
- Modify:
  - `packages/server/src/transports/http.ts`: options, plus routing `/api/*` before the 404.
  - `packages/server/src/cli/run.ts`: build the dashboard registry once and pass deps.
- Test:
  - `packages/server/test/unit/transports/dashboard/{api,body}.test.ts`
  - `packages/server/test/integration/dashboard-api.test.ts`

**Interfaces:**

- Consumes: Task 1 (`ToolEventBus.after`, `SseStream`, `toolInputJsonSchema`, `toolProfiles`, the contract types),
  `ConnectionManager.health()`, `ToolRegistry.list()` / `.call()`.
- Produces in `api.ts`:
  - `interface DashboardApiDeps { config: Readonly<Config>; registry: ToolRegistry; events: ToolEventBus;
connection: Pick<ConnectionManager, 'health'>; version: string; startedAt: Date; mcpEndpoint: string | null; logger: Logger }`.
  - `createDashboardApi(deps): { handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> }`.
  - `handle` is called only after the transport has checked Host, Origin and the token.
- Produces in `body.ts`: `readJsonBody(req, maxBytes = 1_048_576): Promise<JsonValue>`. It throws a typed
  `BodyError` with an HTTP status: 413 when too large, 415 when not `application/json`, 400 on invalid JSON.
- Routes (JSON responses with `Cache-Control: no-store`; errors are `DashboardError`):
  - `GET /api/info` → `DashboardInfo`. `toolCount` is the number of tools the registry offers. `mcpEndpoint` is
    `http://<host>:<port>/mcp` in HTTP mode and `null` next to stdio.
  - `GET /api/health` → `DashboardHealth` from `connection.health()`.
  - `GET /api/tools` → `DashboardToolList` for the registry's tools, in registration order.
    `annotations.openWorldHint` defaults to `false`, as MCP registration does.
  - `POST /api/tools/<name>` with `DashboardCallRequest`:
    - → `registry.call(name, arguments ?? {}, 'dashboard')` and returns `DashboardCallResult` with status 200, also
      when the tool failed.
    - An unknown name gives 404, `arguments` that is not an object gives 400, and body errors keep their status.
  - `GET /api/events?limit=<0–500, default 200>` → an SSE stream.
    - **Without `Last-Event-ID`:** replay `events.recent(limit)`.
    - **With `Last-Event-ID: <n>`:** replay `events.after(n)`, and first send `event: gap` with data `{}` when
      `gap` is true.
    - **Then:** live events through `subscribe`, each as `event: tool` with `id: <seq>`. Unsubscribe on close.
  - Any other `/api` path gives 404; a wrong method gives 405 with `Allow`.
- In `http.ts`:
  - `HttpTransportOptions` gains `dashboard?: { api: ReturnType<typeof createDashboardApi>; dir?: string }`. Task 3
    uses `dir`.
  - Paths starting with `/api/` go through the same Host, Origin and token checks as `/mcp`, but only the Bearer
    header is accepted: no token in the path or query. Then they go to `api.handle`.
  - With no `dashboard` option, `/api/*` gives 404.
- In `run.ts`: when `config.dashboard` is on, create one dashboard registry with `createMcpServer(config,
deps).registry` next to the per-session servers, and pass the API to the transport.

- [ ] **Step 1: Write the failing tests** (integration, through a real listener, in the style of `http.test.ts`).
  - `GET /api/info without a token is 401 with WWW-Authenticate and never echoes a token`.
  - `GET /api/info with a token in the query or path is 401`.
  - `a foreign Origin on /api is 403 and a rebinding Host is 403`.
  - `/api/info reports the version, profile, tool count and the MCP endpoint without the token`.
  - `/api/tools lists the offered tools with JSON schemas, annotations and profiles`. With `profile: 'core'`, the
    count is 40 and every tool has `core: true`.
  - `POST /api/tools/chart_get_state runs through the registry with origin dashboard and the call appears on the
bus`. Use the fake CDP server. The events have `origin: 'dashboard'`, a start and an end.
  - `POST /api/tools/ui_type_text shows only redacted arguments in the replayed events`.
  - `POST /api/tools/unknown_tool is 404, a non-object arguments is 400, a 2 MB body is 413, text/plain is 415`.
  - `a tool error comes back as a 200 result with isError true and the error code`.
  - `GET /api/events replays recent events and then streams live ones, each with its seq as id`.
  - `GET /api/events with Last-Event-ID replays only newer events and announces a gap when some were dropped`.
  - `an events stream ends cleanly when the server closes`.
  - Unit: `readJsonBody` limits, and the 404 and 405 routing.
- [ ] **Step 2: Run them to verify they fail.**
      Run: `pnpm -C packages/server exec vitest run test/integration/dashboard-api.test.ts test/unit/transports/dashboard`.
      Expected: FAIL.
- [ ] **Step 3: Implement** with the interfaces above.
- [ ] **Step 4: Run them to verify they pass,** then run the full server gate.
- [ ] **Step 5: Commit:** `feat(http): serve the dashboard API with tool calls, health and a live event stream`.

---

### Task 3: Serving the dashboard, next to HTTP and next to stdio

**Files:**

- Create:
  - `packages/server/src/transports/dashboard/static.ts`
  - `packages/server/src/transports/dashboard/server.ts`: the stdio-side listener.
- Modify:
  - `packages/server/src/transports/http.ts`
  - `packages/server/src/cli/run.ts`
  - `packages/server/src/cli/banner.ts`
- Test:
  - `packages/server/test/unit/transports/dashboard/static.test.ts`
  - `packages/server/test/integration/dashboard-serve.test.ts`
  - `packages/server/test/unit/cli/{run,banner}.test.ts` (extend)

**Interfaces:**

- Consumes: Task 2 (`createDashboardApi`, `HttpTransportOptions.dashboard`), the `http-security.ts` helpers.
- Produces in `static.ts`:
  - `resolveDashboardDir(): string | null` returns `fileURLToPath(new URL('./dashboard/', import.meta.url))` when it
    holds an `index.html`, else `null`.
  - `serveDashboard(req, res, dir: string, path: string): Promise<boolean>` serves `GET` and `HEAD`, and returns
    false when it did not handle the request.
  - Rules:
    - Decode the path, and refuse any segment that is `..`, contains a NUL, or resolves outside `dir`: 404.
    - Content types: html, js, css, svg, png, ico, json, txt, woff2 and webmanifest; anything else is
      `application/octet-stream`.
    - `/assets/*` gets `Cache-Control: public, max-age=31536000, immutable`; `index.html` gets `no-cache`.
    - **SPA fallback:** a path with no extension whose `Accept` includes `text/html` gets `index.html`. Other misses
      give 404.
    - Every response carries:
      - `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
      - `X-Content-Type-Options: nosniff`
      - `Referrer-Policy: no-referrer`
      - `X-Frame-Options: DENY`
- Produces in `server.ts`: `startDashboardServer(options: { config; logger; api; dir }): Promise<{ url: string; close(): Promise<void> } | null>`.
  - It is the stdio-side listener on `httpHost:httpPort`, with the same Host, Origin and token rules.
  - It serves `/healthz`, `/api/*` and the static files only, and `/mcp` gives 404.
  - It reuses the router in `http.ts`; extract a shared `createRouter` there rather than copying it.
  - `EADDRINUSE` or any listen error gives a warning naming the port and returns `null`.
- In `http.ts`, after `/healthz` and before `/mcp`: when `dashboard.dir` is set, `serveDashboard` handles `GET` and
  `HEAD` for paths outside `/mcp*` and `/api*`, with no token.
- In `run.ts`:
  - **HTTP mode with `config.dashboard`:** pass `dir: resolveDashboardDir()`. When it is null, log a warning
    ("dashboard files not found") and serve MCP and `/api` as usual.
  - **Stdio mode with `config.dashboard`:**
    - Without `authToken`, warn that the dashboard needs `TV_MCP_AUTH_TOKEN` and skip it.
    - Otherwise start `startDashboardServer`. Its failure never stops stdio.
- `renderBanner` gains `dashboard?: string`: a line `Dashboard  http://127.0.0.1:8787/`, without the token. The info
  log line says the same.

- [ ] **Step 1: Write the failing tests.**
  - `the dashboard index is served at / without a token, with the security headers`.
  - `an unknown route that accepts html falls back to index.html, and a missing asset is 404`.
  - `path traversal is 404`. Cover `/../package.json`, `/%2e%2e/x`, a `%00` and a backslash form.
  - `assets are immutable and the index is not cached`.
  - `/mcp still needs its token and /api still needs its token when the dashboard is served`.
  - `HTTP mode without built dashboard files logs one warning and still serves MCP`.
  - `stdio with --dashboard and a token serves the dashboard and the API but not /mcp`.
  - `stdio with --dashboard and no token logs that TV_MCP_AUTH_TOKEN is needed and starts no listener`.
  - `stdio with --dashboard on a taken port logs a warning and the MCP server keeps answering`.
  - `the banner shows the dashboard URL and never the token`.
  - `--no-dashboard in HTTP mode serves neither the files nor /api`.
- [ ] **Step 2: Run them to verify they fail.**
      Run: `pnpm -C packages/server exec vitest run test/unit/transports/dashboard/static.test.ts test/integration/dashboard-serve.test.ts test/unit/cli`.
      Expected: FAIL.
- [ ] **Step 3: Implement** with the interfaces above. Tests use a temporary directory with a synthetic
      `index.html` and assets.
- [ ] **Step 4: Run them to verify they pass,** then run the full server gate.
- [ ] **Step 5: Commit:** `feat(http): serve the dashboard at the root and next to stdio`.

---

### Task 4: The dashboard package

**Files:**

- Create `packages/dashboard/`:
  - `package.json` (`tradingview-desktop-mcp-dashboard`, private)
  - `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `index.html`, `components.json` (shadcn)
  - `src/main.tsx`, `src/app.tsx`, `src/styles.css`
  - `src/lib/utils.ts` (`cn`)
  - `src/components/ui/*`: the shadcn button, card, badge, input, textarea, label, dialog, sheet, tabs, select,
    switch, separator, tooltip, scroll-area, skeleton and alert
  - `src/components/layout/{app-shell,theme-toggle}.tsx`
  - `src/pages/{status,log,tools}-page.tsx` (placeholders)
  - `src/test/setup.ts`
- Modify:
  - root `package.json`: the `build` order, and `dev:dashboard`
  - `eslint.config.js`: a dashboard block
  - `packages/server/package.json`: `build` copies the dashboard
  - Create `packages/server/scripts/copy-dashboard.mjs`
- Test:
  - `packages/dashboard/src/app.test.tsx`
  - `packages/server/test/unit/scripts/copy-dashboard.test.ts`

**Interfaces:**

- **`package.json` scripts:**
  - `dev`: `vite`
  - `build`: `tsc --noEmit && vite build`, output `packages/dashboard/dist`
  - `typecheck`: `tsc --noEmit`
  - `test`: `vitest run`
  - `test:coverage`: `vitest run --coverage`
  - `test:e2e`: `playwright test`, added in Task 9
  - Pick versions current at implementation time. React 19, Vite 8 (the version the workspace already uses),
    Tailwind 4, MSW 2 and the workspace's Vitest 5.
- **tsconfig:** extends `../../tsconfig.base.json` with `module: ESNext`, `moduleResolution: Bundler`,
  `jsx: react-jsx`, `lib: [ES2023, DOM, DOM.Iterable]`, and types for vite client, vitest globals and jest-dom.
  - Paths: `@/*` → `src/*`, and `@contract` → `../server/src/transports/dashboard/contract.ts`. It is a type-only
    import, and the file has no imports of its own.
- **Vite:** `@vitejs/plugin-react` and `@tailwindcss/vite`, with the alias `@`.
  - The dev server proxies `/api` and `/healthz` to `http://127.0.0.1:${TV_MCP_HTTP_PORT ?? 8787}`.
  - It uses `changeOrigin: true`, and a `proxyReq` hook sets `Origin` to the target, so the server's Origin check
    passes.
- **Vitest:** jsdom, globals, `src/test/setup.ts` (jest-dom matchers, MSW server lifecycle), and v8 coverage over
  `src/**` excluding `src/components/ui/**`, `src/main.tsx` and tests, with an 80% threshold on all four metrics.
- **ESLint:** for `packages/dashboard/**/*.{ts,tsx}`, browser globals and `eslint-plugin-react-hooks` recommended.
  The existing strict typed rules apply. `packages/dashboard/src` keeps `no-console`.
- **Build order:**
  - root `build` becomes `pnpm --filter tradingview-desktop-mcp-dashboard build && pnpm --filter
tradingview-desktop-mcp build`;
  - server `build` becomes `tsup && node scripts/copy-dashboard.mjs`.
  - `copy-dashboard.mjs` copies `../dashboard/dist` to `dist/dashboard`. When `../dashboard/dist/index.html` is
    missing it fails with "build the dashboard first: pnpm build".
- **App shell:**
  - A header with the product name, a nav (`/`, `/log`, `/tools`) through `wouter`, a theme toggle (system default,
    stored in `localStorage` under `tvmcp.theme`, `dark` class on `<html>`), and a main area.
  - It uses semantic landmarks (`header`, `nav`, `main`). The page title is "TradingView MCP Dashboard".

- [ ] **Step 1: Write the failing tests.**
  - `the app shell renders the nav and switches pages by path`.
  - `the theme toggle switches the dark class and remembers the choice`.
  - `copy-dashboard copies the built files and fails with the build hint when they are missing`.
- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** Add the shadcn components with the shadcn CLI (copied into `src/components/ui`), and
      use Tailwind's own theme tokens. Bundle no fonts and fetch nothing remotely.
- [ ] **Step 4: Run the root gate.** `pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm test:coverage`
      must pass, and `packages/server/dist/dashboard/index.html` must exist after `pnpm build`.
- [ ] **Step 5: Commit:** `feat(dashboard): add the dashboard app shell and ship its build with the server`.

---

### Task 5: API client, token gate and data hooks

**Files:**

- Create:
  - `packages/dashboard/src/api/{client,token,events}.ts`
  - `packages/dashboard/src/hooks/{use-info,use-health,use-tools,use-call-tool,use-event-log}.ts`
  - `packages/dashboard/src/components/token-gate.tsx`
  - `packages/dashboard/src/test/{handlers,fixtures}.ts`
- Test: `packages/dashboard/src/**/*.test.ts(x)` beside each file.

**Interfaces:**

- Consumes: the `@contract` types and the Task 2 routes.
- **`token.ts`:**
  - `readToken(): string | null` returns the `sessionStorage` key `tvmcp.token`.
  - `takeTokenFromLocation(): string | null` reads `#token=…`, stores it trimmed, and removes the fragment with
    `history.replaceState`.
  - `storeToken(t: string): void` trims.
  - `clearToken(): void`.
- **`client.ts`:**
  - `class ApiError extends Error { status: number }`.
  - `apiGet<T>(path)` and `apiPost<T>(path, body)` send `Authorization: Bearer`.
  - On a 401 they clear the token, throw `ApiError` with status 401, and notify a `onUnauthorized` subscriber.
- **`events.ts`:**
  - `streamEvents(options: { lastEventId: number | null; signal: AbortSignal; onEvent(e: DashboardEvent): void;
onGap(): void; onOpen(): void }): Promise<void>` uses `fetch` with the Bearer header and parses the SSE text
    stream.
  - It handles `id`, `event` and `data` lines, comments, and chunks split anywhere.
  - It exposes `lastEventId` from the last `id:` line.
- **Hooks** (TanStack Query, with one `QueryClient` in `app.tsx`):
  - `useInfo()`.
  - `useHealth()` polls every 5000 ms with `refetchInterval`, never overlapping (React Query keeps one fetch in
    flight).
  - `useTools()`.
  - `useCallTool()` is a mutation to `POST /api/tools/<name>`.
  - `useEventLog(): { calls: ToolCall[]; status: 'connecting' | 'live' | 'reconnecting'; missed: boolean; paused: boolean;
pause(): void; resume(): void; clear(): void }`.
    - `ToolCall { id; tool; origin; startedAt; args; endedAt?; durationMs?; ok?; errorCode?; seq }` merges start and
      end by `id`.
    - It keeps at most 1000 calls, dropping the oldest.
    - It reconnects with backoff (1 s, 2 s, 4 s, capped at 15 s) using `lastEventId`.
    - While paused, events are buffered and appended on resume.
- **`token-gate.tsx`:** it wraps the app.
  - With no token, it shows a form: a label and a password input "Access token", and a "Connect" button. Its help
    text names `TV_MCP_AUTH_TOKEN`.
  - It verifies with `GET /api/info`. On success it stores the token and renders the children. A 401 shows "That
    token was not accepted." On a 401 later, it returns to the form.
- **MSW `handlers.ts`:** handlers for every route, with synthetic fixtures: 6 tools across 3 domains,
  `profile: 'full'`, a health report, and an SSE handler that streams scripted events.

- [ ] **Step 1: Write the failing tests.**
  - `a token in the URL fragment is stored trimmed and removed from the address`.
  - `a pasted token with spaces and a newline connects` (Review Focus 1).
  - `a wrong token shows the not-accepted message and stays on the form`.
  - `a 401 from any later call returns to the token form`.
  - `the SSE parser handles events split across chunks, comments and multi-line data`.
  - `useEventLog merges start and end events into one call by id`.
  - `useEventLog keeps the newest 1000 calls` (Review Focus 3).
  - `useEventLog reconnects with Last-Event-ID after a drop without duplicating calls and reports a gap` (Review
    Focus 2).
  - `useEventLog buffers while paused and appends on resume`.
  - `useHealth never starts a second request while one is in flight` (Review Focus 5). Use a slow MSW handler and
    fake timers, and count the requests.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter tradingview-desktop-mcp-dashboard test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass,** with dashboard coverage at least 80%.
- [ ] **Step 5: Commit:** `feat(dashboard): connect to the dashboard API with a token gate and a live event log`.

---

### Task 6: Status page and connection badge

**Files:**

- Create:
  - `packages/dashboard/src/pages/status-page.tsx`
  - `packages/dashboard/src/components/status/{server-card,tradingview-card,plan-limits-card,recent-activity}.tsx`
  - `packages/dashboard/src/components/layout/connection-badge.tsx`
- Test: beside each.

**Interfaces:**

- Consumes: Task 5 hooks.
- **Server card:** version, transport, profile, the tool count, the MCP endpoint (or "stdio"), and whether
  `ui_evaluate` is allowed.
- **TradingView card:** CDP reachable or not with its endpoint, chart found, the tab count, in background, app ready
  and build time.
  - When CDP is not reachable it shows: "TradingView is not reachable on <endpoint>. Start it with
    `tradingview-desktop-mcp launch`."
  - When it is in the background it shows: "A chart is open but not in front."
- **Plan limits card:** shown only when `app_get_plan_limits` is offered.
  - A "Read plan limits" button calls it through `useCallTool`, so the call appears in the log.
  - It renders a table of features, with 99999 as "Unlimited" and null as "Unknown".
  - An error result shows its code and message.
- **Recent activity:** the last 5 calls from `useEventLog`, with a link to `/log`.
- **Connection badge** (header):
  - "TradingView ready" (green) when `app.ready`;
  - "Chart in background" when `chart.inBackground`;
  - "TradingView not reachable" when `!cdp.reachable`;
  - otherwise "Connecting".
  - It uses text, not colour alone.

- [ ] **Step 1: Write the failing tests.**
  - `the status page shows the server facts from /api/info`.
  - `TradingView not reachable shows the endpoint and the launch hint` (Review Focus 5).
  - `plan limits are read on demand, show Unlimited and Unknown, and the call is a dashboard call`.
  - `the plan limits card is hidden when the profile does not offer app_get_plan_limits`.
  - `recent activity lists the last five calls`.
  - `the connection badge names each state in text`.
- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass,** with coverage.
- [ ] **Step 5: Commit:** `feat(dashboard): show the server, TradingView and plan limits on the status page`.

---

### Task 7: Live log page

**Files:**

- Create:
  - `packages/dashboard/src/pages/log-page.tsx`
  - `packages/dashboard/src/components/log/{call-table,call-filters,call-detail}.tsx`
- Test: beside each.

**Interfaces:**

- Consumes: `useEventLog`.
- **Table:** newest first. Columns: time (local `HH:mm:ss`), tool, origin badge (`mcp`, `batch`, `dashboard`),
  status ("Running", "OK", or the error code) and duration (ms).
  - Each row is a button that opens the detail sheet.
  - Render at most the 200 newest rows that pass the filters, with "Showing 200 of N".
- **Filters:**
  - a text search on the tool name;
  - an origin select (all, mcp, batch, dashboard);
  - a status select (all, running, ok, error).
  - They are kept in the URL query (`?q=&origin=&status=`).
- **Controls:**
  - Pause and Resume, which show the buffered count;
  - Clear, which is client-only;
  - a stream indicator ("Live", "Reconnecting…", "Connecting…");
  - and when `missed`, the line "Some calls were missed while disconnected."
- **Detail sheet:** tool, origin, start and end time, duration, and status with the error code.
  - It shows the arguments as formatted JSON. A `{ "redacted": true }` value shows as "redacted (hidden by the
    server)".
  - Copy buttons for the tool name and the arguments.

- [ ] **Step 1: Write the failing tests.**
  - `live calls appear newest first with their status and duration`.
  - `filters narrow the table and are kept in the URL`.
  - `pause buffers new calls and resume shows them`.
  - `clear empties the table without closing the stream`.
  - `the detail sheet shows redacted arguments as hidden by the server`.
  - `a long log renders at most 200 rows and says how many there are`.
  - `the stream indicator and the missed-calls line follow the stream state`.
- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass,** with coverage.
- [ ] **Step 5: Commit:** `feat(dashboard): add the live tool call log`.

---

### Task 8: Tools page and manual runs

**Files:**

- Create:
  - `packages/dashboard/src/pages/tools-page.tsx`
  - `packages/dashboard/src/components/tools/{tool-list,tool-detail,schema-fields,args-editor,run-confirm,call-result}.tsx`
  - `packages/dashboard/src/lib/{schema,json-view}.ts`
- Test: beside each.

**Interfaces:**

- Consumes: `useTools`, `useCallTool`.
- **Routes:** `/tools` and `/tools/:name`.
- **List:** a search on name, title and description; a domain select; profile toggles (core, readonly); and an
  annotation filter (read-only, changes, destructive). Each item shows the name, the title, and badges for
  read-only, destructive and core.
- **Detail:**
  - title, name, and the description with its paragraphs kept;
  - the annotations and profiles;
  - the schema fields from `lib/schema.ts`: `schemaFields(schema): { name: string; type: string; required: boolean;
description?: string; constraints: string[] }[]`. Constraints cover min and max, length, enum, pattern and
    default.
- **Args editor:**
  - a textarea of JSON prefilled with `{}`;
  - it parses on change and shows "Not valid JSON: <message>";
  - it refuses a non-object;
  - "Run" is disabled while the JSON is invalid or a run is in progress.
- **Run:**
  - A tool with `readOnlyHint: true` runs at once.
  - Any other tool first opens a confirm dialog: "Run <name>? It acts on your TradingView." It shows the arguments,
    with Cancel and Run. A destructive tool also gets "It can remove or replace data." in the dialog.
  - The tool's own `confirm` argument is untouched, and the server's rules apply.
- **Result:**
  - OK or Error, `meta.via`, `durationMs` and warnings;
  - for an error, its `code`, `message` and `hint`;
  - `structuredContent` as formatted JSON;
  - image blocks as `<img src="data:<mimeType>;base64,<data>" alt="Tool image">`.
  - `lib/json-view.ts` `formatJson(value, limit = 20000): { text: string; truncated: boolean }`. A truncated result
    shows "Show all".

- [ ] **Step 1: Write the failing tests.**
  - `the tool list filters by search, domain, profile and annotation`.
  - `the detail shows the description paragraphs and the schema fields with constraints`.
  - `invalid JSON disables Run and explains why`.
  - `a read-only tool runs at once and shows its result`.
  - `a tool that changes things asks for confirmation, and Cancel sends nothing`.
  - `a destructive tool's confirmation warns that it can remove or replace data`.
  - `an error result shows its code, message and hint`.
  - `an image result renders as an image`.
  - `a 50 000-character result is collapsed behind Show all` (Review Focus 4).
  - `/tools/<name> opens that tool, and an unknown name says it is not offered`.
- [ ] **Step 2: Run them to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass,** with coverage.
- [ ] **Step 5: Commit:** `feat(dashboard): browse the tools and run one by hand`.

---

### Task 9: Playwright, CI and screenshots

**Files:**

- Create:
  - `packages/dashboard/playwright.config.ts`
  - `packages/dashboard/e2e/{mock-server.mjs,fixtures.mjs}`
  - `packages/dashboard/e2e/{auth,status,log,tools}.spec.ts`
  - `packages/dashboard/e2e/screenshots.spec.ts`
  - `packages/server/scripts/dashboard-e2e-server.ts`
- Modify:
  - `.github/workflows/ci.yml`
  - `packages/dashboard/package.json` (scripts `test:e2e`, `test:e2e:real`, `docs:screenshots`)
  - `docs/images/` (screenshots)

**Interfaces:**

- **`mock-server.mjs`:** `node:http` on port 4173. It serves `packages/dashboard/dist` (SPA fallback) and implements
  every Task 2 route with synthetic fixtures.
  - The token is `e2e-token-0123456789abcdef0123456789abcdef`.
  - `POST /api/tools/<name>` records the call and pushes start and end events to the SSE clients.
  - A test-only `POST /__control/emit` pushes scripted events.
- **Playwright projects:**
  - **`mocked`:** the default, used in CI. `webServer` runs `node e2e/mock-server.mjs`. Chromium only.
  - **`real`:** run with `test:e2e:real`, locally only. `webServer` runs `tsx ../server/scripts/dashboard-e2e-server.ts`,
    which starts the fake CDP server and the fake TradingView from the server's test helpers. It then starts the
    built server's HTTP transport with the dashboard on a free port and a generated token, and prints the URL and
    token to Playwright through an env file.
    - With `TV_E2E=1` it connects to the real app instead. Only read-only checks run then: the status page shows it
      ready, and a run of `chart_get_state` succeeds.
- **Specs:**
  - `auth`: token screen, wrong token, and token from the fragment.
  - `status`: server facts, TradingView state, and plan limits on demand.
  - `log`: an emitted call appears live; filters; pause and resume.
  - `tools`: search, open a tool, a read-only run, the confirm dialog for a non-read-only tool, and an error result.
- **`screenshots.spec.ts`:** tagged `@screenshots` and run only by `docs:screenshots`. It writes
  `docs/images/dashboard-status.png`, `dashboard-log.png` and `dashboard-tools.png` from the mock server, at
  1280×800 in light theme.
- **CI:** a new job `dashboard-e2e` (`needs: verify`). It checks out, sets up pnpm and Node, installs with
  `--frozen-lockfile`, runs `pnpm --filter tradingview-desktop-mcp-dashboard build`, runs `pnpm --filter
tradingview-desktop-mcp-dashboard exec playwright install --with-deps chromium`, then
  `pnpm --filter tradingview-desktop-mcp-dashboard test:e2e`. On failure it uploads the Playwright report.

- [ ] **Step 1: Write the four specs** (the `mocked` project).
- [ ] **Step 2: Run them to verify they fail.** Run `pnpm --filter tradingview-desktop-mcp-dashboard test:e2e`
      before the mock server exists. Expected: FAIL, because the web server does not start.
- [ ] **Step 3: Implement the mock server, the real-server script and the CI job.**
- [ ] **Step 4: Run them.**
  - `pnpm --filter tradingview-desktop-mcp-dashboard test:e2e` passes.
  - `test:e2e:real` passes against the fake app.
  - `TV_E2E=1 test:e2e:real` passes against the user's running TradingView, read-only: it changes nothing and
    prints no personal data.
  - `docs:screenshots` writes the three images.
- [ ] **Step 5: Commit:** `test(dashboard): add Playwright suites against a mocked and a real server`. The images
      go in a separate `docs:` commit.

---

### Task 10: Documentation

**Files:**

- Modify:
  - `README.md`: the "A web dashboard is planned" line becomes a Dashboard section with the screenshots.
  - `docs/testing.md`: dashboard unit and E2E.
  - `SECURITY.md`: the dashboard and the browser.
  - `CONTRIBUTING.md`: dashboard development.
  - `.env.example`
  - spec §8, §9 and §11, for the decisions of this plan.
- Test: `packages/server/test/integration/docs-examples.test.ts`, or a new docs test, checks that the README names
  the dashboard routes and flags that exist.

**Interfaces:**

- **README:**
  - how to open it: HTTP mode at `http://127.0.0.1:8787/`, or next to stdio with `--dashboard` and
    `TV_MCP_AUTH_TOKEN`;
  - pasting the token, or opening `…/#token=<token>`, whose fragment is never sent to the server;
  - what each page does, and that dashboard runs are real tool calls with the same rules.
- **SECURITY.md:**
  - the static files are public and hold no secrets;
  - `/api/*` needs the Bearer token, never in the URL;
  - the token stays in the tab's `sessionStorage`;
  - the CSP and the Host/Origin checks;
  - never expose the dashboard through a tunnel without the readonly profile.
- **`docs/testing.md`:** the dashboard unit tests and the coverage threshold, the Playwright `mocked` and `real`
  projects, `TV_E2E=1` for the real app, and the CI job.
- **CONTRIBUTING.md:** `pnpm dev:dashboard` against a running server (the proxy rewrites Origin), and how to add a
  shadcn component.
- **Spec:**
  - §8: "Unauthenticated routes: `/healthz` and the static dashboard files; `/api/*` takes the Bearer token only."
  - §9: the dashboard next to stdio needs `TV_MCP_AUTH_TOKEN`.
  - §11: the `dashboard-e2e` job.

- [ ] **Step 1: Write the failing docs test.** `the README documents the dashboard routes, the token and --dashboard`.
- [ ] **Step 2: Run it to verify it fails.**
- [ ] **Step 3: Update the docs.**
- [ ] **Step 4: Run the root gate.**
- [ ] **Step 5: Commit:** `docs: document the dashboard`.
