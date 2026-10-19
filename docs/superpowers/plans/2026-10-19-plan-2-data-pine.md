# Plan 2: Data and Pine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the market data, indicator, Pine Script, Pine output and Strategy Tester tools (31 tools), their resources and prompts, plan-limit awareness, and README usage examples generated from the fake app.

**Architecture:** Builds on Plan 1. Page functions reach TradingView's webpack services through a small page-side library injected per call (`PageBridge.evaluateWithLib`), so no globals are left on the page and module IDs are never hardcoded. Every tool checks plan limits before acting, keeps the Plan 1 envelope and tier rules, and is tested against the fake CDP server and fake TradingView window, which this plan extends.

**Tech Stack:** As Plan 1 (TypeScript 6 strict, `@modelcontextprotocol/sdk` 1.32.x, zod 4, Vitest 5, tsup, chrome-remote-interface). `tsx` runs repository scripts.

**Spec:** [docs/superpowers/specs/2026-10-18-tradingview-mcp-design.md](../specs/2026-10-18-tradingview-mcp-design.md) (§5 tool contract, §7 catalog, §10 testing), [docs/reverse-engineering.md](../../reverse-engineering.md) (§4 page entry points). Plan 1: [2026-10-18-plan-1-foundation.md](2026-10-18-plan-1-foundation.md).

## Global Constraints

- All Plan 1 Global Constraints still apply (TypeScript strict, no `any`, ESM, English only, stderr-only logs, Conventional Commits without AI attribution, coverage ≥80% for `packages/server/src`, never `--options=clean`, loopback-only CDP, no personal data or real prices in committed files).
- Never bypass authentication, paywalls, or plan limits. Check the relevant plan limit **before** acting and fail with `PLAN_LIMIT` (feature + limit) instead of letting TradingView open a paywall dialog.
- Webpack services are reached only by **export name** through `PageLib`, reading already-instantiated modules (`require.c`). Never call `require(id)`, never hardcode module IDs, never leave globals on the page.
- Pine safety: never delete a saved Pine script and expose no delete or rename tool for scripts. Saving a new version of a script this session did not create needs `confirm: true` (TradingView keeps the earlier versions). Never discard unsaved Pine editor content without `confirm: true`.
- Destructive operations on pre-existing user data need `confirm: true` (design spec §5.3 rule 2). This now includes `indicator_remove` of an indicator this server session did not create.
- `pine_smart_compile` applies deterministic, rule-based fixes only. The server never calls an AI model.
- Page functions follow Plan 1 rules: self-contained, registered in `src/core/tv/page-functions.ts`, `CAPABILITY_UNAVAILABLE` raised only before acting, results JSON-typed with `type` aliases.
- Times in outputs are Unix seconds plus an ISO string. Tool inputs are validated without schema transforms.
- E2E against the real app may only read, or change what the test itself created and then restore or remove it. Tests that would exceed a plan limit are skipped with the feature name. Never touch the user's existing indicators, scripts, drawings, or alerts.

## Review Focus

1. **Plan limit already reached** (the user's chart holds 2 of 2 indicators): `indicator_add` and `pine_compile` with `addToChart: true` return `PLAN_LIMIT` naming `INDICATORS_ON_CHART` and the limit, and add nothing. Pinned in Task 5 (`indicator_add returns PLAN_LIMIT and adds nothing when the chart is full`) and Task 8 (`pine_compile with addToChart returns PLAN_LIMIT on a full chart`).
2. **Unsaved Pine editor content:** `pine_new`, `pine_open`, and `pine_set_source` refuse with `CONFIRMATION_REQUIRED` and leave the editor untouched. Pinned in Task 7 (`pine_set_source refuses to replace unsaved content without confirm`).
3. **Pine sources with CRLF line endings, tabs, or non-ASCII text:** compile errors and analyzer diagnostics report 1-based line and column numbers that match the text the user sees. Pinned in Task 8 (`compile errors keep 1-based positions for CRLF sources`) and Task 9 (`diagnostics count columns in UTF-16 code units after a tab and an emoji`).
4. **More bars requested than loaded or allowed:** `data_get_ohlcv` returns what exists with `complete: false` and a warning within the call timeout, and never hangs. Pinned in Task 3 (`data_get_ohlcv returns the loaded bars and complete false when history stops growing`).
5. **Indicator plots without titles, with duplicate titles, colorer plots, or NaN values:** `indicator_get_values` returns `null` for NaN, skips colorer plots, and keeps keys stable (plot ID fallback, `#2` suffix for duplicates). Pinned in Task 4 (`indicator_get_values keys plots stably and maps NaN to null`).

---

### Task 1: Page library and webpack export access

**Files:**

- Create: `src/core/tv/page-lib.ts`
- Modify: `src/core/tv/page-bridge.ts` (add `evaluateWithLib`), `src/core/tv/tv-window.ts` (type `webpackChunktradingview`), `src/core/tv/page-functions.ts`
- Modify (harness): `test/helpers/fake-tv/window.ts` (add `webpackModules` override), create `test/helpers/fake-tv/webpack.ts`
- Test: `test/unit/core/tv/page-lib.test.ts`, `test/unit/core/tv/page-bridge.test.ts` (extend), `test/integration/page-lib.test.ts`

(All `src/` and `test/` paths are relative to `packages/server/`.)

**Interfaces:**

- Consumes: `PageBridge`, `PageErrorSentinel`, `TvWindow` (Plan 1).
- Produces:
  - `type PageLib = { findExport(name: string): unknown; findModuleWith(names: string[]): Record<string, unknown> | null }` (a plain object of closures, created once per evaluate)
  - `type PageLibFunction<A extends JsonValue[], R extends JsonValue | null> = (win: TvWindow, lib: PageLib, ...args: A) => R | PageErrorSentinel | Promise<R | PageErrorSentinel>`
  - page function `createPageLib(win: TvWindow): PageLib` (registered in `page-functions.ts`)
  - `PageBridge.evaluateWithLib<A, R>(fn: PageLibFunction<A, R>, args: A, options?: { timeoutMs?: number }): Promise<R>`, expression `(${fn})(window, (${createPageLib})(window), ...${JSON.stringify(args)})`, with the same error mapping as `evaluate`
  - test helper `createFakeWebpack(modules: Record<string, Record<string, unknown>>): unknown[]` (a chunk array whose `push([[id], {}, runtime])` calls `runtime(require)` with `require.c` holding the modules) and `FakeTvOverrides.webpackModules`

- [ ] **Step 1: Write the failing tests.**
  - `findExport returns a cached module's own export`: with fake modules `{ a: { studyMetaInfoRepository: fn } }`, `lib.findExport('studyMetaInfoRepository')` is that function.
  - `findExport ignores inherited names and uncached modules`: `toString` → `null`; a module present only in factories (not in `require.c`) is never instantiated (spy on the factory: not called).
  - `findModuleWith requires every name on one module`.
  - `the library obtains require once per evaluate`: one `push` per `evaluateWithLib` call, however many lookups.
  - `createPageLib returns a library whose lookups return null without a chunk array` (no throw).
  - Bridge: `evaluateWithLib builds the expression with the library before the arguments` (assert the expression string shape) and maps sentinels like `evaluate`.
  - Integration: `evaluateWithLib reaches a webpack export through the fake CDP page`.
- [ ] **Step 2: Run the tests to verify they fail.** Run: `pnpm -C packages/server vitest run test/unit/core/tv test/integration/page-lib.test.ts`. Expected: FAIL (missing module and method).
- [ ] **Step 3: Implement.** The chunk ID is `tvmcp_<Date.now()>_<random>`. `require.c` maps module IDs to `{ exports }` records; the library reads only those (`Object.values(req.c)`, own-property checks on `exports`, `try` around getters). Document in `page-lib.ts` that each push registers one inert chunk ID.
- [ ] **Step 4: Run the tests to verify they pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(tv): add a page library for webpack exports"`

---

### Task 2: Plan limits and `app_get_plan_limits`

**Files:**

- Create: `src/core/tv/plan-limits.ts`
- Modify: `src/tools/app/index.ts` (new tool), `src/core/tv/page-functions.ts`, `test/e2e/setup.ts` (skip helper), harness (`ProductFeatures` + `getConfig` fake modules in the fixture)
- Test: `test/unit/core/tv/plan-limits.test.ts`, `test/integration/tools/app.test.ts` (extend), `test/unit/e2e/setup.test.ts` (extend)

**Interfaces:**

- Consumes: `PageLib`, `evaluateWithLib` (Task 1); `PlanLimitError(feature, limit, message?, hint?)` (Plan 1).
- Produces:
  - `const PLAN_FEATURES = ['INDICATORS_ON_CHART', 'SAVED_PINE_SCRIPTS', 'CHART_STORAGE', 'MULTIPLE_CHARTS', 'SERVER_SIDE_ALERTS', 'WATCHLIST_SYMBOLS', 'STUDY_TEMPLATES', 'HISTORICAL_BARS'] as const`; `type PlanFeature = (typeof PLAN_FEATURES)[number]`
  - page function `readPlanLimits(win: TvWindow, lib: PageLib, features: string[]): Record<string, number | null>` (via `ProductFeatures[name]` and `getConfig(value).limit`; `null` when unknown)
  - `getPlanLimits(page: PageHandle, features: readonly PlanFeature[]): Promise<Partial<Record<PlanFeature, number | null>>>`
  - `requireBelowLimit(feature: PlanFeature, used: number, limit: number | null | undefined, hint: string): void` (throws `PlanLimitError` when `limit` is a number and `used >= limit`)
  - tool `app_get_plan_limits` (`{}` → `{ limits: Record<PlanFeature, number | null> }`, read-only, core)
  - E2E helper `planLimitSkipReason(client: Client, feature: PlanFeature, used: number, needed: number): Promise<string | null>`

- [ ] **Step 1: Write the failing tests.**
  - `readPlanLimits reads limits through ProductFeatures and getConfig`: fake gives `INDICATORS_ON_CHART: 2`, returns `{ INDICATORS_ON_CHART: 2 }`.
  - `readPlanLimits reports null for unknown features and missing modules`.
  - `requireBelowLimit throws PLAN_LIMIT with feature and limit at the limit`, `requireBelowLimit passes below the limit`, `requireBelowLimit passes when the limit is unknown`.
  - Integration: `app_get_plan_limits returns every plan feature` (unknown ones are `null`).
  - `planLimitSkipReason names the feature and limit when the chart is full` and `returns null when there is room or the limit is unknown`.
- [ ] **Step 2: Run the tests to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** The two exports live in different modules (captured bundles): `ProductFeatures` with `ProductFeaturesEnum` and `UNLIMITED_FEATURE_LIMIT`, and `getConfig` with `getProductFeaturesConfig`, `canUpgradePlan` and `enabled`. Find them with `lib.findExport('ProductFeatures')` and `lib.findModuleWith(['getConfig', 'getProductFeaturesConfig'])`, because `getConfig` alone is a common export name. Relay limits as reported (99999, `UNLIMITED_FEATURE_LIMIT`, means unlimited; say so in the tool description). Hints name the plan feature and say the plan allows N.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(tv): read plan limits and expose them as a tool"`

---

### Task 3: Market data tools

**Files:**

- Create: `src/tools/data/index.ts`, `src/tools/data/page.ts`, `src/tools/data/mappers.ts`
- Modify: `src/tools/index.ts`, `src/core/tv/page-functions.ts`, `src/core/tv/tv-window.ts`, harness (`requestMoreData` growth model, search results, quote cache)
- Test: `test/unit/tools/data/mappers.test.ts`, `test/unit/tools/data/page.test.ts`, `test/integration/tools/data.test.ts`

**Interfaces:**

- Consumes: `resolveChartTarget`, `pageWaitMs` (`src/tools/chart/strategies.ts`); `toIso`, `parseTimeInput`; `pollUntil`.
- Produces: `export const dataTools` with:
  - `data_get_ohlcv` `{ count?: 1–5000 = 100, from?, to?, chartIndex? }` → `{ symbol, resolution, bars: { time, timeIso, open, high, low, close, volume }[], complete: boolean }`. Loads more history through `mainSeries().requestMoreData(n)` when the series has it, polling `bars().size()` until it stops growing or the page wait ends.
  - `data_get_quote` `{ symbol? }` → `{ symbol, last, change, changePercent, bid, ask, bidSize, askSize, high, low, open, prevClose, volume, currency, time, timeIso }` (fields `null` when absent). The chart symbol reads `mainSeries().quotes()`; another symbol reads the quote session cache and otherwise fails `NOT_AVAILABLE` (hint: switch the chart to it).
  - `data_get_symbol_info` `{ symbol? }` → `{ source: 'chart' | 'search', symbol, fullName, proName, exchange, listedExchange, description, type, typespecs, currency, pricescale, minmov, pointvalue, session, timezone, hasIntraday, hasExtendedHours, isReplayable }`. A symbol other than the chart's uses the best search match, with fewer fields and `source: 'search'`.
  - `data_search_symbols` `{ query, exchange?, type?, limit?: 1–50 = 20 }` → `{ results: { symbol, ticker, description, exchange, type, currency }[], remaining: number }` (HTML tags stripped).
  - `data_get_market_depth` `{ symbol?, levels?: 1–50 = 10 }` → `{ symbol, levels: 1, fullDepth: false, bids: { price, size }[], asks: { price, size }[] }` from the quote's top of book. When `levels` asks for more than one, add a warning that full depth needs a broker connection or a depth data entitlement. No new depth session is created (it would count against `BACKEND_CONNECTIONS`). `NOT_AVAILABLE` without bid and ask.
  - mappers `toBarRows(rows, from?, to?, count)`, `mapQuote(values)`, `mapSearchResult(item)`, `stripTags(text)`
  - `readOhlcvData(ctx: ToolContext, input: { count: number; from?: number; to?: number; chartIndex?: number }): Promise<{ data; warnings: string[] }>`, the `data_get_ohlcv` body, exported for the `chart/ohlcv` resource the way `readChartStateData` is in `src/tools/chart/index.ts`

- [ ] **Step 1: Write the failing tests.**
  - Mappers: `toBarRows keeps the last count bars inside from/to`, `mapQuote maps TradingView quote fields and nulls missing ones` (keys `last_price`, `ch`/`change`, `chp`/`change_percent`, `bid`, `ask`, `bid_size`, `ask_size`, `high_price`, `low_price`, `open_price`, `prev_close_price`, `volume`, `currency_code`, `lp_time`), `stripTags removes <em> highlights`.
  - Integration: `data_get_ohlcv returns the last 100 bars with ISO times`; **`data_get_ohlcv returns the loaded bars and complete false when history stops growing`** (asks 5000, fake stops at 300, finishes before `callTimeoutMs`); `data_get_quote reads the chart symbol`; `data_get_quote fails NOT_AVAILABLE for an uncached symbol`; `data_search_symbols strips tags and honors limit`; `data_get_market_depth returns one level from the quote and warns when more levels were asked for`.
- [ ] **Step 2: Run the tests to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** All read tools are `readOnlyHint: true` and core except `data_get_market_depth`.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(data): add OHLCV, quote, symbol info, search and depth tools"`

---

### Task 4: Indicator reads: list, search, values

**Files:**

- Create: `src/tools/indicator/index.ts`, `src/tools/indicator/page.ts`, `src/tools/indicator/mappers.ts`
- Modify: `src/tools/index.ts`, `src/core/tv/page-functions.ts`, `src/core/tv/tv-window.ts` (`StudyApiLike`, study core `data()`, `metaInfo()`), harness (study data rows, `metaInfo.plots`/`styles`, `studyMetaInfoRepository` fake)
- Test: `test/unit/tools/indicator/mappers.test.ts`, `test/unit/tools/indicator/page.test.ts`, `test/integration/tools/indicator.test.ts`

**Interfaces:**

- Consumes: Task 1 (`evaluateWithLib`); `resolveChartTarget`.
- Produces:
  - `type StudyInput = { id: string; name: string; type: string; value: JsonValue; options: string[] | null }`; `type StudyInfo = { id: string; name: string; title: string; visible: boolean; isPine: boolean; isStrategy: boolean; inputs: StudyInput[] }`
  - tools `indicator_list` `{ chartIndex? }` → `{ studies: StudyInfo[] }`; `indicator_search` `{ query, limit?: 1–50 = 20 }` → `{ results: { name, shortName, id, isStrategy }[] }` (from `studyMetaInfoRepository().findAllJavaStudies()`, matched case-insensitively on description and short description; `name` is what `indicator_add` accepts); `indicator_get_values` `{ id, count?: 1–500 = 1, at?, chartIndex? }` → `{ id, plots: string[], rows: { time, timeIso, values: Record<string, number | null> }[] }`
  - mapper `plotKeys(plots: { id: string; type: string }[], styles: Record<string, { title?: string }>): { index: number; key: string }[]` (skips `colorer` and other non-value plots; title, else plot ID; duplicate titles get `#2`, `#3`)

- [ ] **Step 1: Write the failing tests.**
  - **`indicator_get_values keys plots stably and maps NaN to null`**: plots `[{id:'plot_0',type:'line'},{id:'plot_1',type:'line'},{id:'plot_2',type:'colorer'}]`, styles titles `EMA`, `EMA`: keys `['EMA', 'EMA#2']`, a NaN value comes back `null`, the colorer is absent.
  - `plotKeys falls back to the plot id without a title`.
  - Integration: `indicator_list returns studies with inputs and visibility`; `indicator_search finds Relative Strength Index by "rsi"`; `indicator_get_values at a time returns the bar at or before it`; `indicator_get_values fails INVALID_INPUT for an unknown id` (hint: `indicator_list`).
- [ ] **Step 2: Run the tests to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** Read-only tools, `readOnlyHint: true`, core. Search loads metadata through the existing repository; never request it from servers directly.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(indicator): list, search and read indicator values"`

---

### Task 5: Indicator changes: add, remove, inputs, visibility

**Files:**

- Modify: `src/tools/indicator/index.ts`, `src/tools/indicator/page.ts`, `src/tools/types.ts` (`SessionState.createdStudyIds: Set<string>`), `src/server.ts` (initialize it), `src/core/tv/page-functions.ts`, harness (`createStudy` with `checkLimit`, `canCreateStudy`, `removeEntity`, `setInputValues`, `setVisible`)
- Test: `test/integration/tools/indicator.test.ts` (extend), `test/unit/tools/indicator/page.test.ts` (extend)

**Interfaces:**

- Consumes: Task 2 (`getPlanLimits`, `requireBelowLimit`), Task 4 types.
- Produces: tools `indicator_add` `{ name, inputs?: Record<string, string | number | boolean>, overlay?: boolean, chartIndex? }` → `{ id, name, chartIndex }`; `indicator_remove` `{ id, confirm?, chartIndex? }` → `{ removed: string }`; `indicator_set_inputs` `{ id, inputs, chartIndex? }` → `{ id, previous: StudyInput[], current: StudyInput[] }`; `indicator_set_visibility` `{ id, visible, chartIndex? }` → `{ id, visible }`.

- [ ] **Step 1: Write the failing tests.**
  - **`indicator_add returns PLAN_LIMIT and adds nothing when the chart is full`**: fake limit 2, two studies; error code `PLAN_LIMIT`, `details.feature === 'INDICATORS_ON_CHART'`, `details.limit === 2`, and `createStudy` was never called.
  - `indicator_add passes checkLimit and records the id in the session`.
  - `indicator_add fails INVALID_INPUT for an unknown indicator name` (hint: `indicator_search`).
  - `indicator_remove requires confirm for an indicator the session did not create` (`CONFIRMATION_REQUIRED`, `removeEntity` not called); `indicator_remove removes a study this session added without confirm`.
  - `indicator_set_inputs accepts input ids or names and returns previous values`; `indicator_set_inputs rejects unknown inputs and wrong types with INVALID_INPUT` (nothing set).
  - `indicator_set_visibility hides and shows a study`.
- [ ] **Step 2: Run the tests to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** Before `createStudy`, use the model's `canCreateStudy` when it exists (read-only), else compare `getAllStudies().length` with `INDICATORS_ON_CHART`. Always call `createStudy` with `checkLimit: true`, so TradingView still enforces its own limit; never pass `false`. Validate inputs against the study's `getInputsInfo()` (design spec §7) before calling `setInputValues`. Annotations: `indicator_add` not destructive; `indicator_remove` `destructiveHint: true`; setters `idempotentHint: true`.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(indicator): add, remove and edit indicators within plan limits"`

---

### Task 6: Pine editor access layer

**Files:**

- Create: `src/tools/pine/editor.ts` (Node side), `src/tools/pine/page.ts` (page functions)
- Modify: `src/core/tv/page-functions.ts`, `src/core/tv/tv-window.ts` (`pineEditorApi()` members), harness (`createFakePineEditor`: placement, facade methods `awaitEditorReady`, `isModified`, `isDraft`, `getScriptIdVersion`, `openNewScript`, `openScript`, `setScript`, `getSource`, `addToChart`, `updateOnChart`, `saveScript`; `getOpenPineEditor` export)
- Test: `test/unit/tools/pine/page.test.ts`, `test/integration/tools/pine-editor.test.ts`

**Interfaces:**

- Consumes: Task 1.
- Produces:
  - `type PineEditorState = { open: boolean; placement: 'bottom' | 'dialog' | null; modified: boolean; draft: boolean; script: { id: string; version: string } | null }`
  - page functions `readPineEditorState(win, lib)`, `openPineEditor(win, lib, waitMs)` (calls `TradingViewApi.pineEditorApi().open()` and waits for a facade), `closePineEditor(win, lib)` (only if the reverse-engineered close path exists; else `CAPABILITY_UNAVAILABLE`)
  - Node: `readEditorState(page: PageHandle): Promise<PineEditorState>`, `ensureEditorOpen(page, waitMs): Promise<PineEditorState>`, `requireUnmodifiedOrConfirmed(state: PineEditorState, confirm: boolean | undefined, action: string): void` (throws `CONFIRMATION_REQUIRED` when `modified && !confirm`)

- [ ] **Step 1: Write the failing tests.**
  - `readPineEditorState reports closed when no facade is registered`.
  - `ensureEditorOpen opens the editor and reports its placement`.
  - `requireUnmodifiedOrConfirmed refuses modified content without confirm` and `allows it with confirm`.
  - Integration: `the editor state reads through the fake page`.
- [ ] **Step 2: Run the tests to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** Find the facade with `lib.findExport('getOpenPineEditor')` for `'bottom'` then `'dialog'`. Find the close path by static search of the captured bundles and a read-only probe; record what was found in the report.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(pine): add Pine editor access with an unsaved-changes guard"`

---

### Task 7: Pine source tools, list and save

**Files:**

- Create: `src/tools/pine/index.ts`
- Modify: `src/tools/pine/page.ts`, `src/tools/index.ts`, `src/core/tv/page-functions.ts`, `src/tools/types.ts` (`SessionState.createdScriptIds: Set<string>`), `src/server.ts`, harness (saved scripts list via `requestUserScripts`, `SAVED_PINE_SCRIPTS` limit)
- Test: `test/integration/tools/pine.test.ts`

**Interfaces:**

- Consumes: Tasks 2 and 6.
- Produces: `readPineSourceData(ctx: ToolContext): Promise<{ data: { source, script, modified }; warnings: string[] }>` (the `pine_get_source` body, which never opens the editor; for the `pine/source` resource); `export const pineTools` (later tasks append); tools `pine_new` `{ type?: 'indicator' | 'strategy' | 'library' = 'indicator', source?, confirm? }`; `pine_open` `{ scriptId?, name?, confirm? }` (exactly one); `pine_get_source` `{}` → `{ source, script, modified }`; `pine_set_source` `{ source, confirm? }`; `pine_list_scripts` `{}` → `{ scripts: { id, name, version, type, modified: string | null }[] }`; `pine_save` `{ name?, confirm? }` → `{ script: { id, version }, created: boolean }` (a script it creates goes into `createdScriptIds`).

- [ ] **Step 1: Write the failing tests.**
  - **`pine_set_source refuses to replace unsaved content without confirm`** (`CONFIRMATION_REQUIRED`; facade `setScript` not called; source unchanged).
  - `pine_new opens a strategy template and sets the given source`.
  - `pine_open by name opens the matching saved script`; `pine_open fails INVALID_INPUT for an unknown script`.
  - `pine_get_source opens no editor and fails NOT_AVAILABLE when it is closed` (hint: `pine_new` or `pine_open`).
  - `pine_list_scripts returns saved scripts`.
  - `pine_save of a new draft returns PLAN_LIMIT when the saved-script limit is reached`.
  - `pine_save of a script this session did not create requires confirm` (`CONFIRMATION_REQUIRED`, `saveScript` not called); `pine_save with confirm saves a new version`; `pine_save of a script this session created saves without confirm`.
- [ ] **Step 2: Run the tests to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** `pine_get_source` and `pine_list_scripts` are read-only. Nothing here deletes or renames scripts.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(pine): add source, open, list and save tools"`

---

### Task 8: Compile, errors, and console

**Files:**

- Create: `src/tools/pine/compile.ts`, `src/tools/pine/mappers.ts`
- Modify: `src/tools/pine/index.ts`, `src/tools/pine/page.ts`, `src/tools/types.ts` (`SessionState.lastPineCompile: PineCompileResult | null`), `src/server.ts`, harness (`translateScriptAsync` fake with success and error results, editor console messages in `TVLocalStorage` under `console_messages_key`, study `logs()`)
- Test: `test/unit/tools/pine/mappers.test.ts`, `test/integration/tools/pine.test.ts` (extend)

**Interfaces:**

- Consumes: Tasks 2, 6, 7.
- Produces:
  - `type PineCompileError = { line: number; column: number; endLine: number | null; endColumn: number | null; message: string; severity: 'error' | 'warning' }`
  - `type PineCompileResult = { success: boolean; errors: PineCompileError[]; warnings: PineCompileError[]; addedToChart: boolean; studyId: string | null; compiledAt: string }`
  - `normalizeCompileErrors(raw: unknown, source: string): { errors: PineCompileError[]; warnings: PineCompileError[] }` (1-based; CRLF counted as one line break)
  - `compileSource(page: PageHandle, source: string, waitMs: number): Promise<PineCompileResult>` (compile only, through `translateScriptAsync`)
  - tools `pine_compile` `{ source?, addToChart?: boolean = false }` (`source` compiles that text only; `addToChart` adds the editor's script, so both together are `INVALID_INPUT` with the hint to call `pine_set_source` first), `pine_get_errors` `{}`, `pine_get_console` `{ limit?: 1–500 = 100 }` → `{ messages: { time, timeIso, level, text, source: 'editor' | 'script' }[] }`

- [ ] **Step 1: Write the failing tests.**
  - **`compile errors keep 1-based positions for CRLF sources`**: an error on line 3 of a `\r\n` source is reported as `line: 3`.
  - `normalizeCompileErrors separates warnings`.
  - Integration: `pine_compile compiles the editor source without touching the chart` (`addedToChart: false`, chart studies unchanged); `pine_compile with source compiles that text instead`; `pine_compile rejects source together with addToChart`; `pine_compile reports errors with positions`; **`pine_compile with addToChart returns PLAN_LIMIT on a full chart`**; `pine_compile with addToChart adds the script when a slot is free` (and records the study in `createdStudyIds`); `pine_get_errors returns the last compile result of the session`; `pine_get_console merges editor and script messages newest first`.
- [ ] **Step 2: Run the tests to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** Find the compile-only API with `lib.findExport('translateScriptAsync')`; confirm its result and error shapes from the captured bundles (`handleTranslateResult`) before mapping.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(pine): compile scripts and read errors and console output"`

---

### Task 9: Offline Pine analyzer

**Files:**

- Create: `src/tools/pine/analyze/rules.ts`, `src/tools/pine/analyze/analyze.ts`, `src/tools/pine/analyze/fixes.ts`
- Modify: `src/tools/pine/index.ts` (tool `pine_analyze`)
- Test: `test/unit/tools/pine/analyze.test.ts`, `test/integration/tools/pine.test.ts` (extend)

**Interfaces:**

- Produces:
  - `type PineFix = { description: string; edits: { line: number; column: number; endColumn: number; replacement: string }[] }`
  - `type PineDiagnostic = { ruleId: string; severity: 'error' | 'warning' | 'info'; line: number; column: number; message: string; fix: PineFix | null }`
  - `analyzePine(source: string): PineDiagnostic[]`
  - `applyFixes(source: string, fixes: PineFix[]): { source: string; applied: string[] }` (non-overlapping edits, applied bottom-up)
  - tool `pine_analyze` `{ source? }` → `{ version: number | null, diagnostics: PineDiagnostic[] }` (editor source when omitted; read-only; works offline when `source` is given)
- Rules (each with a fix when deterministic): `missing-version` (add `//@version=6` on line 1), `old-version` (info, version below 5), `study-declaration` (`study(` → `indicator(`), `security-namespace` (`security(` → `request.security(`), `ta-namespace` (v4 built-ins `sma ema rsi macd stoch atr crossover crossunder highest lowest change` → `ta.*`), `str-namespace` (`tostring` → `str.tostring`), `missing-declaration` (no `indicator(`, `strategy(`, or `library(`), `strategy-calls-without-strategy` (`strategy.*` calls in an indicator), `lookahead-repaint` (warning for `lookahead = barmerge.lookahead_on`), `too-many-plots` (more than 64 `plot*(` calls).

- [ ] **Step 1: Write the failing tests.** One test per rule (positive and negative case), plus:
  - **`diagnostics count columns in UTF-16 code units after a tab and an emoji`**.
  - `applyFixes applies non-overlapping edits and skips overlapping ones`.
  - `analyzePine ignores code in comments and strings` (`// study(` and `"security("` produce nothing).
  - Integration: `pine_analyze with source works without TradingView` (closed CDP port, still succeeds).
- [ ] **Step 2: Run the tests to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement** a small tokenizer that skips comments and string literals; rules match identifiers and call positions on tokens, not raw text.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(pine): add an offline Pine analyzer with deterministic fixes"`

---

### Task 10: Smart compile

**Files:**

- Create: `src/tools/pine/smart-compile.ts`, `src/utils/diff.ts`
- Modify: `src/tools/pine/index.ts`
- Test: `test/unit/utils/diff.test.ts`, `test/unit/tools/pine/smart-compile.test.ts`, `test/integration/tools/pine.test.ts` (extend)

**Interfaces:**

- Consumes: Tasks 8 and 9 (`compileSource`, `analyzePine`, `applyFixes`).
- Produces:
  - `unifiedDiff(before: string, after: string, context?: number): string` (line-based, LCS)
  - `fixesForCompileErrors(source: string, errors: PineCompileError[]): PineFix[]` (maps known compiler messages, for example undeclared `rsi` → `ta.rsi`, to analyzer fixes)
  - tool `pine_smart_compile` `{ source?, maxAttempts?: 1–5 = 3, applyFixes?: boolean = true, writeBack?: boolean = false, confirm? }` → `{ success, attempts: { errors: PineCompileError[]; applied: string[] }[], source, diff }`. `writeBack` writes the final source into the editor and is guarded like `pine_set_source`.

- [ ] **Step 1: Write the failing tests.**
  - `unifiedDiff returns an empty string for equal texts` and `marks changed lines with context`.
  - `smart compile fixes a v4 script in two attempts`: `study("x")` + `plot(rsi(close,14))` → success on attempt 2, `applied` lists `study-declaration` and `ta-namespace`.
  - `smart compile stops after maxAttempts and returns the last errors`.
  - `smart compile with applyFixes false only compiles once`.
  - `smart compile writeBack refuses unsaved editor content without confirm`.
- [ ] **Step 2: Run the tests to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** Stop early when an attempt applies no new fix.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(pine): add smart compile with rule-based fixes"`

---

### Task 11: Pine outputs: lines, labels, boxes, tables

**Files:**

- Create: `src/tools/pine/outputs.ts` (tools), `src/tools/pine/outputs-page.ts`, `src/tools/pine/outputs-mappers.ts`
- Modify: `src/tools/pine/index.ts`, `src/core/tv/page-functions.ts`, `src/core/tv/tv-window.ts`, harness (study `graphics()` with `dwglines`, `dwglabels`, `dwgboxes`, `dwgtables`, `dwgtablecells` nested maps)
- Test: `test/unit/tools/pine/outputs-mappers.test.ts`, `test/integration/tools/pine-outputs.test.ts`

**Interfaces:**

- Produces: tools `pine_get_lines`, `pine_get_labels`, `pine_get_boxes`, `pine_get_tables`, each `{ studyId?, limit?: 1–500 = 100, chartIndex? }`, reading `graphics().dwg*()` of the given Pine study (or every Pine study with outputs). Outputs:
  - lines `{ studyId, id, start: { barIndex, time, timeIso, price }, end: { barIndex, time, timeIso, price }, extend, color, width, style }[]`
  - labels `{ studyId, id, barIndex, time, timeIso, price: number | null, yloc, text, color, textColor, style }[]`
  - boxes `{ studyId, id, left: { barIndex, time, timeIso }, right: { barIndex, time, timeIso }, top, bottom, extend, text, borderColor, bgColor }[]`
  - tables `{ studyId, id, position, rows, columns, cells: { row, column, text }[] }[]`
  - Every point also carries `barIndex` (the raw x when `xloc` is a bar index, else `null`). Times come from the bar row at that index (`mainSeries().bars().valueAt`), the same time base as `data_get_ohlcv`, and are `null` outside the loaded bars; `xloc` bar-time values (milliseconds) become seconds directly. Absent fields are `null`.

- [ ] **Step 1: Write the failing tests.**
  - Mappers: `labels map yloc above-bar and below-bar with a null price`, `lines convert bar indices to times`, `a point past the last loaded bar keeps its barIndex and a null time`, `tables gather cells by row and column`.
  - Integration: one test per tool against a fake Pine study; `pine_get_lines with an unknown studyId fails INVALID_INPUT`; `pine outputs report an empty list for a study without drawings`.
- [ ] **Step 2: Run the tests to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** Confirm item field names (`x1`, `y1`, `x2`, `y2`, `xloc`, `yloc`, `text`, `left`, `right`, `top`, `bottom`, `extend`, colors) against the captured bundles (consumers of `dwglines()` etc.) before mapping. Reverse-engineering notes §12 lists this as an open question; record the answer in the report.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(pine): read lines, labels, boxes and tables drawn by scripts"`

---

### Task 12: Strategy Tester tools

**Files:**

- Create: `src/tools/strategy/index.ts`, `src/tools/strategy/page.ts`, `src/tools/strategy/mappers.ts`
- Modify: `src/tools/index.ts`, `src/core/tv/page-functions.ts`, `src/core/tv/tv-window.ts`, harness (a strategy study with `reportData()`: `performance.all/long/short`, `trades`, `currency`, initial capital)
- Test: `test/unit/tools/strategy/mappers.test.ts`, `test/integration/tools/strategy.test.ts`

**Interfaces:**

- Produces: `export const strategyTools` with
  - `strategy_get_results` `{ studyId?, chartIndex? }` → `{ strategy: { id, name }, currency, performance: { all, long, short } }` (each a `Record<string, number>` of the numeric fields TradingView reports, names unchanged)
  - `strategy_get_trades` `{ studyId?, limit?: 1–1000 = 100, offset?: 0 }` → `{ total, trades: { number, isOpen, side: 'long' | 'short' | null, entry: { time, timeIso, price, signal }, exit: { time, timeIso, price, signal } | null, quantity, profit, profitPercent, cumulativeProfit, runup, drawdown }[] }`
  - `strategy_get_equity` `{ studyId?, maxPoints?: 2–5000 = 500 }` → `{ initialCapital, points: { time, timeIso, equity }[], downsampled: boolean }` (from the report's equity series when present, else derived from closed trades' cumulative profit)
  - mapper `downsample(points, maxPoints)` (keeps first and last, and each bucket's min and max)
  - `readStrategyResultsData(ctx: ToolContext, studyId?: string): Promise<{ data; warnings: string[] }>`, the `strategy_get_results` body, for the `strategy/report` resource

- [ ] **Step 1: Write the failing tests.**
  - Mappers: `downsample keeps the first, last and extreme points`, `trades map entry and exit with ISO times`, `equity is derived from cumulative profit without an equity series`.
  - Integration: `strategy_get_results returns all, long and short performance`; `strategy tools fail NOT_AVAILABLE without a strategy on the chart` (hint: add one with `pine_compile` and `addToChart`); `strategy_get_trades pages with offset and limit`.
- [ ] **Step 2: Run the tests to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** Confirm trade field names (`entry`/`exit` objects, `isOpen`, `profit`, `cumulativeProfit`, `runup`, `drawdown`) in the captured `80588` report bundle before mapping. All tools are read-only.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(strategy): read Strategy Tester results, trades and equity"`

---

### Task 13: Resources and prompts

**Files:**

- Create: `src/prompts/index.ts`
- Modify: `src/resources/index.ts`, `src/server.ts` (register prompts), `src/core/events.ts` (carry-forward fix from Plan 1)
- Test: `test/integration/resources.test.ts`, `test/integration/prompts.test.ts`, `test/unit/core/events.test.ts` (extend)

**Interfaces:**

- Consumes: `readOhlcvData` (Task 3), `readPineSourceData` (Task 7), `SessionState.lastPineCompile` (Task 8), `readStrategyResultsData` (Task 12). Resources reuse them and duplicate no logic.
- Produces:
  - resources `tradingview://chart/ohlcv` (last 100 bars), `tradingview://pine/source` (editor source; never opens the editor, fails `NOT_AVAILABLE` when closed), `tradingview://pine/errors` (the session's last compile result, or an empty result), `tradingview://strategy/report` (active strategy results)
  - `registerPrompts(server: McpServer): void` with prompts `analyze_current_chart` `{ focus? }`, `multi_timeframe_review` `{ timeframes? = "1D,4h,1h" }`, `write_and_backtest_strategy` `{ idea, symbol?, timeframe? }`, `debug_pine_script` `{}`. Each returns one user message naming the tools to call in order and what to report back.

- [ ] **Step 1: Write the failing tests.**
  - `lists every resource`, `reads the OHLCV resource`, `the Pine source resource does not open the editor` (fake editor stays closed), `the strategy report resource fails NOT_AVAILABLE without a strategy`.
  - `lists the four prompts with their arguments`, `write_and_backtest_strategy names pine_new, pine_smart_compile, pine_compile and strategy_get_results`.
  - `ToolEventBus.recent floors a fractional limit`: with 3 events, `recent(0.5)` is `[]` and `recent(2.7)` is the newest 2 (today `slice(-0.5)` returns every event).
- [ ] **Step 2: Run the tests to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement** with `McpServer.registerPrompt` (confirm the signature in the installed SDK).
- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(server): add data and Pine resources and analysis prompts"`

---

### Task 14: Usage examples and README

**Files:**

- Create: `packages/server/scripts/docs/examples.ts`, `docs/examples.md` (generated), `packages/server/scripts/docs/scenarios.ts`
- Modify: `README.md` (a "Use it" section), root `package.json` (`docs:examples`), `packages/server/package.json`
- Test: `test/integration/docs-examples.test.ts`

**Interfaces:**

- Consumes: `createMcpServer`, `connectInMemoryClient`, fake CDP server and fake window with `chart-basic` (synthetic NASDAQ:AAPL).
- Produces:
  - `type Scenario = { title: string; prompt: string; steps: { tool: string; arguments: Record<string, JsonValue> }[]; summary: string }`
  - `SCENARIOS: Scenario[]` (at least 8): read the chart, switch symbol and timeframe, last candles, indicator values, search and add an indicator (showing a `PLAN_LIMIT` result on a full chart), write and compile a Pine script, smart compile a v4 script, backtest results.
  - `renderExamples(results): string` (deterministic markdown: prompt, tool calls, trimmed JSON results with times fixed by the fixture, assistant summary)
  - `pnpm docs:examples` regenerates `docs/examples.md`

- [ ] **Step 1: Write the failing test** `docs/examples.md is up to date`: run every scenario against the fake app and compare `renderExamples` output with the committed file; the failure message says to run `pnpm docs:examples`.
- [ ] **Step 2: Run the test to verify it fails.** Expected: FAIL (file missing).
- [ ] **Step 3: Implement the generator and write the README section.** The README section covers:
  - running from source (`pnpm install && pnpm build`, start TradingView with `--remote-debugging-port=9222`);
  - Claude Desktop config (`"command": "node", "args": ["<abs path>/packages/server/dist/cli.js"]`) and Claude Code (`claude mcp add tradingview -- node <abs path>/packages/server/dist/cli.js`);
  - a "Try these prompts" list (6 prompts, each with a short result excerpt) linking to `docs/examples.md`;
  - a note that example values are synthetic.

  Results are trimmed (for example the first 3 bars) so the page stays readable. Never include personal data or real prices.

- [ ] **Step 4: Run the test to verify it passes.** Run: `pnpm docs:examples && pnpm -C packages/server vitest run test/integration/docs-examples.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "docs: add usage examples generated from the fake app"`

---

### Task 15: E2E against the real app, observations, and docs

**Files:**

- Create: `test/e2e/data.e2e.test.ts`, `test/e2e/indicator.e2e.test.ts`, `test/e2e/pine.e2e.test.ts`
- Modify: `test/e2e/setup.ts`, `scripts/re/record-fixtures.ts` (record study and strategy report shapes), `docs/reverse-engineering.md` (§12 answered, §4 facts), `docs/testing.md` (plan-aware skips), and the fake window and fixtures where an observation proves them wrong
- Test: the E2E files above (`TV_E2E=1`)

**Interfaces:**

- Consumes: every tool of this plan; `planLimitSkipReason` (Task 2).

- [ ] **Step 1: Write the E2E suites.**
  - `data.e2e.test.ts` (read-only): `OHLCV returns ascending bars`, `quote of the chart symbol has a last price`, `symbol info of the chart symbol`, `search finds AAPL`.
  - `indicator.e2e.test.ts`:
    - read-only: `lists the chart's indicators`, `reads the last value of the first indicator`, `search finds RSI`;
    - `adding an indicator on a full chart returns PLAN_LIMIT and changes nothing` (runs when the chart is full: studies before = after);
    - `adds and removes RSI` (runs only when a slot is free; removes only its own study);
    - never calls `indicator_set_inputs`, `indicator_set_visibility` or `indicator_remove` on pre-existing studies.
  - `pine.e2e.test.ts`:
    - `analyze works offline`;
    - `compile-only reports errors with positions for an invalid script` and `succeeds for a valid script` (no chart change);
    - `lists saved scripts`;
    - editor flow `new → set source → get source` (skipped when the editor has unsaved content; restores the editor's open or closed state; never saves);
    - outputs and strategy tests skip with the `INDICATORS_ON_CHART` reason when no slot is free.
- [ ] **Step 2: Run against the real app.** Run: `TV_E2E=1 pnpm test:e2e`. Expected: PASS with plan-limit skips named. Record before/after state (studies, editor open state, chart state) in the report.
- [ ] **Step 3: Record real-app observations** in the report and update `docs/reverse-engineering.md`:
  - the editor placement and close path;
  - the compile-only result shape and error positions;
  - the `findAllJavaStudies` fields;
  - `canCreateStudy` semantics;
  - quote field names;
  - `requestMoreData` behavior;
  - the plan-limit source.

  Fix any contradicted assumption with a focused commit and a fake update. Extend `pnpm re:record` to record the shapes behind these answers (key names and value types of a study's `metaInfo()` plots and styles, `getInputsInfo()`, `getStudyById`, and a strategy report when one is on the chart). It records shapes only, never input values, prices or script names, and runs them through the existing scrubber (carry-forward from Plan 1).

- [ ] **Step 4: Update `docs/testing.md`** with the plan-aware skip rules and what Plan 2 E2E may touch.
- [ ] **Step 5: Commit.** `git commit -m "test: add data, indicator and Pine E2E suites with plan-aware skips"` (observation fixes in their own `fix(...)` commits).
