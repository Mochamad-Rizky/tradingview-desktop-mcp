# Plan 3: Interaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the drawing, alert, watchlist, layout and pane, tab, replay, screenshot and low-level UI tools (40 tools), the `watchlist/active` resource and the `replay_practice_session` prompt, close the Plan 2 follow-ups, refresh the README usage examples and verify everything against the real app with plan-aware E2E.

**Architecture:** Builds on Plans 1 and 2. Tools follow the established domain layout (`src/tools/<domain>/{index,page,mappers}.ts`), page functions stay self-contained and registered, webpack services are reached through `PageLib`, plan-limited actions run inside `inPlanLimitedTurn` and check their limit first, and input events go through the guarded helpers of `src/core/tv/input.ts`. Unknown internals are confirmed against read-only research notes before a task is dispatched; the fake CDP server and fake TradingView window grow with each domain.

**Tech Stack:** As Plans 1 and 2 (TypeScript 6 strict, `@modelcontextprotocol/sdk` 1.32.x, zod 4, Vitest 5, tsup, chrome-remote-interface, tsx for scripts).

**Spec:** [docs/superpowers/specs/2026-10-18-tradingview-mcp-design.md](../specs/2026-10-18-tradingview-mcp-design.md) (§5 contract and safety rules, §7 catalog rows Drawings to Batch, §10 testing), [docs/reverse-engineering.md](../../reverse-engineering.md) (§2.4 TVD, §4.2 `TradingViewApi`, §4.3 drawings and panes, §4.5 replay, §4.7 webpack services, §5 DOM, §5.5 never click, §5.6 window chrome, §12 open questions 3, 4, 6, 7, 10–14). Earlier plans: [Plan 1](2026-10-18-plan-1-foundation.md), [Plan 2](2026-10-19-plan-2-data-pine.md).

## Global Constraints

- All Plan 1 and Plan 2 Global Constraints still apply (TypeScript strict, no `any`, ESM, English only, stderr-only logs, Conventional Commits without AI attribution, coverage ≥80% for `packages/server/src`, loopback-only CDP, never `--options=clean`, no personal data or real prices in committed files, webpack services only by export name through `PageLib`, self-contained registered page functions, times as Unix seconds plus ISO, no schema transforms).
- No broker trading tools (spec §5.3 rule 1). Low-level UI tools refuse the selectors of reverse-engineering §5.5 and everything the Plan 1 hit test refuses; `replay_trade` acts only on the replay's own paper-trading model and only while replay is active.
- Destructive operations on pre-existing user data need `confirm: true` (spec §5.3 rule 2): `drawing_remove` of a drawing this session did not create, `drawing_clear_all` with `scope: "all"`, `alert_delete` of an alert this session did not create, `watchlist_remove` of a symbol this session did not add, `tab_close` of a tab this session did not open, and `layout_switch` while the current layout has unsaved changes. Objects the server created in this session need none.
- Plan limits are checked before acting and the action runs inside `inPlanLimitedTurn` (spec §5.3 rule 3): `CHART_STORAGE` for `layout_new`, `MULTIPLE_CHARTS` for `pane_set_layout`, `SERVER_SIDE_ALERTS` for `alert_create`, `WATCHLIST_SYMBOLS` for `watchlist_add` and `watchlist_add_bulk`. An unreadable limit refuses (`NOT_AVAILABLE`), never passes. Server-side limit errors are relayed unchanged.
- No tool opens a paywall, sign-in, upgrade or confirmation dialog of the app: pre-check, pass the app's skip-confirm options where they exist, and refuse when the outcome would be a dialog.
- `ui_evaluate` is off unless `TV_MCP_ALLOW_EVAL=true`, runs only in the chart page (never in the window chrome, which has Node integration), and refuses expressions that reach credential and identity surfaces (spec §5.3 rules 4 and 5).
- Screenshots are returned to the client as MCP image content and never written to disk by the server; tests never persist them.
- E2E against the real app may only read, or change what the test itself created and then restore or remove it; anything that would leave a trace the tools cannot remove (a saved layout, a server draft) runs only behind an explicit opt-in variable; tests that would exceed a plan limit skip with the feature name; skip reasons, logs and assertion output carry no values of the user.

## Review Focus

1. **A chart that already holds the user's many drawings:** `drawing_clear_all` with `scope: "created_by_mcp"` removes only this session's drawings, and `drawing_list` pages through a long list. Pinned in Task 5 (`clear_all created_by_mcp removes only this session's drawings and leaves the 50 pre-existing ones`).
2. **Replay left running after a failure:** `replay_stop` leaves replay mode even while autoplay runs or after a step failed, and `replay_status` reports the truth afterwards. Pinned in Task 11 (`replay_stop leaves replay while autoplay runs and after a failed step`).
3. **A coordinate click over a trading control, an open menu or a frame:** `ui_click` with `x`/`y` refuses and sends no mouse press. Pinned in Task 3 (`ui_click at a point over the buy button sends no mouse press`).
4. **A screenshot of a large window on a 2× display with `maxWidth`:** the image is no wider than `maxWidth` and the payload stays bounded. Pinned in Task 2 (`screenshot_capture with maxWidth 800 on a 2x display returns an image at most 800 px wide`).
5. **Bulk watchlist input with duplicates, symbols already listed and unknown symbols:** each symbol gets its own outcome, nothing is added twice, and the limit is checked before anything is added. Pinned in Task 7 (`watchlist_add_bulk reports added, already listed, duplicate and unknown symbols and adds each at most once`).

---

### Task 1: Plan 2 follow-ups

**Files:**

- Modify: `src/tools/pine/{index,page,compile,editor}.ts`, `src/tools/indicator/index.ts`, `src/prompts/index.ts`, `test/e2e/setup.ts` (all paths under `packages/server/` unless they start with `docs/`)
- Test: the matching unit and integration tests, `test/unit/e2e/setup.test.ts`

**Interfaces:**

- Produces: `SessionState.lastWrittenPineText: string | null` (the text this session last wrote into the Pine Editor, kept in memory only, never logged).

- [ ] **Step 1: Write the failing tests.**
  - `the kept unsaved flag does not ask for confirm when the editor holds exactly the text this session wrote` (after a confirmed `pine_new` with source, `pine_set_source` without confirm succeeds while the editor text equals `lastWrittenPineText`, and still refuses when the text differs by one character).
  - `hints name closing the Pine Editor as a way to clear the kept flag` (the `CONFIRMATION_REQUIRED` hints of `pine_set_source`, `pine_compile` addToChart and `pine_save` mention closing the editor).
  - `indicator_add resolves the active chart once` and `pine_compile with addToChart resolves the active chart once` (one layout read per call).
  - `a Pine study the user adds at the same moment is not adopted as created by the session` (only a study whose metainfo matches the script id or source title the call added is recorded).
  - `multi_timeframe_review tells the assistant to restore the visible range too`.
  - `removeStrayStudies re-reads the chart scope before each probe and before each removal and removes nothing when it changed`.
- [ ] **Step 2: Run the tests to verify they fail.** Run: `pnpm -C packages/server exec vitest run test/unit/tools/pine test/unit/tools/indicator test/integration/tools/pine.test.ts test/integration/prompts.test.ts test/unit/e2e/setup.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The fingerprint lives in `SessionState` (initialize it in `src/server.ts` and every test builder); the guard treats "kept flag set and the editor text equals the text this session last wrote" as not the user's. Everything else as the tests state.
- [ ] **Step 4: Run the tests to verify they pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "fix(pine): let the session edit the text it wrote without confirm"` (plus focused commits for the other follow-ups).

---

### Task 2: Screenshot

**Files:**

- Create: `src/tools/screenshot/{index,page}.ts`
- Modify: `src/tools/index.ts`, `src/core/tv/page-functions.ts`, `test/helpers/fake-cdp/` (`Page.captureScreenshot`, `Page.getLayoutMetrics`)
- Test: `test/unit/tools/screenshot/*.test.ts`, `test/integration/tools/screenshot.test.ts`

**Interfaces:**

- Consumes: `ConnectionManager.chartPage()`, `windowChromePage()`; `ToolOutput.images`.
- Produces: tool `screenshot_capture` `{ target?: 'chart' | 'page' | 'window' = 'chart', format?: 'png' | 'jpeg' = 'png', maxWidth?: 100–4000, chartIndex? }` → image content first, then `{ target, format, width, height, bytes }`.

- [ ] **Step 1: Write the failing tests.**
  - **`screenshot_capture with maxWidth 800 on a 2x display returns an image at most 800 px wide`** (fake layout metrics 1600×1000 CSS px at devicePixelRatio 2; the `clip.scale` sent makes the output ≤ 800 px wide; `width`/`height` report the output size).
  - `chart target clips to the chart container of the chosen chart` (clip equals the container's rect; `chartIndex` picks the container).
  - `page captures the whole chart tab and window captures the window chrome target`.
  - `jpeg uses quality 80 and png none`.
  - `the image block comes before the JSON block and the JSON carries no base64` (spec §5.2).
  - `a page without a chart container fails NOT_AVAILABLE`.
- [ ] **Step 2: Run the tests to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement** with CDP `Page.captureScreenshot` (`captureBeyondViewport: false`, `clip` from the container's `getBoundingClientRect()` in CSS pixels, `scale = min(1, maxWidth / (width × devicePixelRatio))` when `maxWidth` is given). Read-only annotations; `openWorldHint: false`.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(screenshot): capture the chart, the page or the window"`

---

### Task 3: Low-level UI, pointer tools

**Files:**

- Create: `src/tools/ui/{index,pointer}.ts`
- Modify: `src/core/tv/input.ts` (point-based variants of the guarded click), `src/core/tv/selectors.ts`, `test/helpers/fake-tv/dom.ts`
- Test: `test/unit/core/tv/input.test.ts` (extend), `test/integration/tools/ui.test.ts`

**Interfaces:**

- Consumes: `InputPage`, `clickElement`, `describeElement`, the per-page input queue, `UNSAFE_SELECTORS` (Plan 1).
- Produces:
  - `clickPoint(page: InputPage, point: { x: number; y: number }): Promise<void>`, `hoverElement(page, selector)`, `hoverPoint(page, point)`, `scrollAt(page, target: { selector } | { x, y }, delta: { x: number; y: number }): Promise<void>` — all guarded like `clickElement` (unsafe target, hit test at the point, overlap-root layer, frame, second look after the pointer moves) and queued per page.
  - `uiTargetPage(ctx, target: 'chart' | 'window'): Promise<PageHandle>`.
  - tools `ui_click` `{ selector?, text?, x?, y?, target? = 'chart' }` (exactly one of `selector`, `text`, or both `x` and `y`; `text` means the first visible element whose accessible name or text equals it, case-insensitively; left button, one click), `ui_hover` (same inputs), `ui_scroll` `{ selector?, x?, y?, deltaX? = 0, deltaY, target? }`, `ui_find_element` `{ selector?, text?, target?, limit?: 1–50 = 10 }` → `{ elements: { selector, tag, role, name, text, rect, visible, unsafe }[] }`.

- [ ] **Step 1: Write the failing tests.**
  - **`ui_click at a point over the buy button sends no mouse press`** (`UNSAFE_ACTION_BLOCKED`; no `Input.dispatchMouseEvent` with `mousePressed`).
  - `ui_click at a point under an open menu of the overlap root refuses with NOT_AVAILABLE` and `… inside a frame refuses`.
  - `ui_click by selector clicks the element's centre after the second look`; `ui_click by text clicks the first visible element with that name and refuses when it is unsafe`.
  - `ui_hover moves the pointer only` (no press) and refuses unsafe targets the same way.
  - `ui_scroll sends one mouseWheel at the target's centre and refuses unsafe targets`.
  - `ui_find_element by text returns visible elements with rects and marks unsafe ones` (an element matching §5.5 has `unsafe: true`).
  - `target window acts on the window chrome page`.
  - `coordinates outside the viewport are INVALID_INPUT`.
- [ ] **Step 2: Run the tests to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** Points are CSS pixels of the page's viewport. Annotations: `ui_click`, `ui_scroll` destructive (they can change anything), `ui_hover`, `ui_find_element` read-only. None is in the core profile.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(ui): add guarded click, hover, scroll and find tools"`

---

### Task 4: Low-level UI, keyboard, panels, fullscreen and evaluate

**Files:**

- Modify: `src/tools/ui/index.ts`, create `src/tools/ui/{keyboard,panels,evaluate}.ts`, `src/core/tv/selectors.ts`
- Test: `test/integration/tools/ui.test.ts` (extend), `test/unit/tools/ui/evaluate.test.ts`

**Interfaces:**

- Consumes: Task 3 (`uiTargetPage`), `typeText`, `pressKey`, `readUiState`, `config.allowEval`.
- Produces: tools `ui_type_text` `{ text: 1–1000 chars, target? }`; `ui_press_key` `{ key, modifiers?: ('Alt' | 'Control' | 'Meta' | 'Shift')[], target? }`; `ui_open_panel` `{ panel: 'watchlist' | 'alerts' | 'object_tree' | 'pine_editor' | 'data_window', open?: boolean = true }` → `{ panel, open }`; `ui_fullscreen` `{ enabled: boolean }` → `{ requested, observed: boolean | null }`; `ui_evaluate` `{ expression: 1–10000 chars }` → `{ value: JsonValue, truncated: boolean }`; `EVAL_DENYLIST: readonly RegExp[]`.

- [ ] **Step 1: Write the failing tests.**
  - `ui_type_text types only into a focused text field` and `ui_press_key refuses while a trading control has the focus` (Plan 1 rules, now reachable as tools).
  - `ui_open_panel opens the watchlist through the right toolbar and reports it open`, `… closing an already closed panel changes nothing`.
  - `ui_fullscreen calls startFullscreen and reports observed null with a warning when the state cannot be read`.
  - `ui_evaluate is refused with CAPABILITY_UNAVAILABLE unless TV_MCP_ALLOW_EVAL is true` and `ui_evaluate is not registered in the readonly profile`.
  - `ui_evaluate refuses expressions that reach TVD credentials, window.user, cookies, storage or indexedDB` (one case per denylist entry, including spacing and bracket forms such as `window['user']`).
  - `ui_evaluate returns JSON-safe values and truncates beyond 100 kB`.
- [ ] **Step 2: Run the tests to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** Panels map to selectors in `SELECTORS` (watchlist, alerts and object tree from the right toolbar; Pine Editor from `pine-dialog-button`; data window from the right toolbar when present, else `CAPABILITY_UNAVAILABLE`). `ui_evaluate` runs `Runtime.evaluate` in the chart page with `returnByValue`, no Node globals, and denies before sending anything. Annotations: `ui_evaluate`, `ui_type_text`, `ui_press_key`, `ui_fullscreen` destructive; `ui_open_panel` idempotent.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(ui): add keyboard, panel, fullscreen and opt-in evaluate tools"`

---

### Task 5: Drawings

**Files:**

- Create: `src/tools/drawing/{index,page,mappers}.ts`, `test/helpers/fake-tv/drawings.ts`
- Modify: `src/tools/index.ts`, `src/core/tv/page-functions.ts`, `src/core/tv/tv-window.ts`
- Test: `test/unit/tools/drawing/*.test.ts`, `test/integration/tools/drawing.test.ts`

**Interfaces:**

- Consumes: `resolveChartTarget`, `parseTimeInput`/`toIso`, `session.createdDrawingIds` (Plan 1).
- Produces:
  - `DRAWING_SHAPES` — the curated enum with point counts, confirmed against the research notes: `horizontal_line` 1, `vertical_line` 1, `horizontal_ray` 1, `trend_line` 2, `ray` 2, `extended` 2, `arrow` 2, `rectangle` 2, `circle` 2, `ellipse` 2, `triangle` 3, `parallel_channel` 3, `fib_retracement` 2, `text` 1, `note` 1, `price_label` 1, `arrow_up` 1, `arrow_down` 1, `flag` 1.
  - tools `drawing_create` `{ shape, points: { time, price }[], text?, style?: { color?, lineWidth?: 1–4, lineStyle?: 'solid' | 'dotted' | 'dashed', fontSize?: 8–40 }, chartIndex? }` → `{ id, shape }`; `drawing_list` `{ chartIndex?, limit?: 1–500 = 100, offset?: 0 }` → `{ total, drawings: { id, shape, points: { time, timeIso, price }[], text: string | null, createdByServer: boolean }[] }`; `drawing_get` `{ id, chartIndex? }`; `drawing_remove` `{ id, confirm?, chartIndex? }` → `{ removed }`; `drawing_clear_all` `{ scope: 'created_by_mcp' | 'all', confirm?, chartIndex? }` → `{ removed: number }`.

- [ ] **Step 1: Write the failing tests.**
  - `drawing_create validates the point count per shape` (`INVALID_INPUT` naming the expected count) and `creates a trend line and records its id in the session`.
  - `drawing_create applies text and style through the creation options, not afterwards`.
  - **`clear_all created_by_mcp removes only this session's drawings and leaves the 50 pre-existing ones`**; `clear_all all requires confirm` (`CONFIRMATION_REQUIRED`, nothing removed); `clear_all all with confirm removes every drawing`.
  - `drawing_remove of a drawing the session did not create requires confirm`; `drawing_remove of an unknown id is INVALID_INPUT with the hint drawing_list`.
  - `drawing_list pages with offset and limit and reports total`.
  - `times above 1e11 are milliseconds, ISO strings are accepted, and points are reported in seconds with ISO`.
- [ ] **Step 2: Run the tests to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement** with the chart API (`createShape` / `createMultipointShape`, `getAllShapes`, `getShapeById`, `removeEntity`, and `removeAllShapes` only for `scope: "all"`), using the option names, return types and undo behaviour the research notes confirm. `drawing_list`, `drawing_get` read-only; `drawing_remove`, `drawing_clear_all` destructive.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(drawing): create, list, read and remove drawings"`

---

### Task 6: Alerts

**Files:**

- Create: `src/tools/alert/{index,page,mappers}.ts`, `test/helpers/fake-tv/alerts.ts`
- Modify: `src/tools/index.ts`, `src/core/tv/page-functions.ts`, `src/core/tv/tv-window.ts`
- Test: `test/unit/tools/alert/*.test.ts`, `test/integration/tools/alert.test.ts`

**Interfaces:**

- Consumes: `PageLib` (`getAlertsRestApi`), `getPlanLimits`, `requireBelowLimit`, `inPlanLimitedTurn`, `session.createdAlertIds`.
- Produces: tools `alert_list` `{ status?: 'active' | 'stopped' | 'triggered' | 'all' = 'all' }` → `{ alerts: { id, symbol, condition, price, message, status, expiration, expirationIso, createdByServer }[] }`; `alert_create` `{ symbol?, condition: 'crossing' | 'crossing_up' | 'crossing_down' | 'greater_than' | 'less_than', price, message?: ≤ 400 chars, expiration? }` → `{ id, symbol, condition, price, expiration, expirationIso }`; `alert_delete` `{ alertIds: 1–50 ids, confirm? }` → `{ deleted: string[] }`.

- [ ] **Step 1: Write the failing tests.**
  - `alert_create returns PLAN_LIMIT SERVER_SIDE_ALERTS when the active alerts fill the plan and sends nothing`; `… refuses when the limit cannot be read`.
  - `alert_create builds the payload the app's alert dialog sends` (the exact field names the research notes confirm), defaults the symbol to the chart's, and records the id.
  - `an expiration in the past is INVALID_INPUT`; `a server-side refusal such as total_alerts_count_exceeded is relayed as PLAN_LIMIT unchanged` (spec §5.3 rule 3).
  - `alert_delete of an alert this session did not create requires confirm`; `alert_delete with ids the account does not have is INVALID_INPUT listing them`; no "delete all" input exists.
  - `two parallel alert_create calls at limit − 1 create one alert` (the shared plan-limit turn).
- [ ] **Step 2: Run the tests to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement** through the app's own alerts REST client (`getAlertsRestApi()`: `listAlerts`, `createAlert`, `deleteAlerts`), never a request of the server's own. `alert_list` read-only; `alert_delete` destructive.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(alert): list, create and delete alerts within the plan's limit"`

---

### Task 7: Watchlists and the `watchlist/active` resource

**Files:**

- Create: `src/tools/watchlist/{index,page,mappers}.ts`, `test/helpers/fake-tv/watchlists.ts`
- Modify: `src/tools/index.ts`, `src/resources/index.ts`, `src/core/tv/page-functions.ts`, `src/tools/types.ts` (`SessionState.addedWatchlistSymbols: Map<string, Set<string>>`), `src/server.ts`
- Test: `test/unit/tools/watchlist/*.test.ts`, `test/integration/tools/watchlist.test.ts`, `test/integration/resources.test.ts` (extend)

**Interfaces:**

- Consumes: `PageLib` (`getCustomLists`, `getCustomListById`, `getGlobalActiveSymbolList`, `initSymbolListService`, `getWatchlistSymbolsLimit`, `MAX_WATCHLIST_LENGTH`), `TVD.getActiveWatchlistId()`, Task 3 of Plan 2 (`data_search_symbols` logic for validation), the plan-limit helpers.
- Produces: tools `watchlist_list` → `{ lists: { id, name, symbolCount, active }[] }`; `watchlist_get` `{ listId? }` → `{ id, name, symbols: string[] }`; `watchlist_add` `{ symbol, listId? }`; `watchlist_add_bulk` `{ symbols: 1–100, listId? }` → `{ listId, added: string[], skipped: { symbol, reason: 'already_listed' | 'duplicate' | 'unknown' }[] }`; `watchlist_remove` `{ symbols: 1–100, listId?, confirm? }` → `{ removed: string[], notListed: string[] }`; resource `tradingview://watchlist/active` (registered only with `watchlist_get`); `readWatchlistData(ctx, listId?)`.

- [ ] **Step 1: Write the failing tests.**
  - **`watchlist_add_bulk reports added, already listed, duplicate and unknown symbols and adds each at most once`**.
  - `watchlist_add returns PLAN_LIMIT WATCHLIST_SYMBOLS before adding when the list is full`; `… refuses when the limit cannot be read`.
  - `watchlist_remove of a symbol this session did not add requires confirm`; `… of a symbol the session added needs none`.
  - `the default list is the active one` and `an unknown listId is INVALID_INPUT with the hint watchlist_list`.
  - `the watchlist/active resource equals watchlist_get without listId and is absent without that tool`.
- [ ] **Step 2: Run the tests to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement** through the app's symbol-list service and its own append/remove calls, with the store wiring the research notes confirm (reverse-engineering §12 question 3); when the service is not created yet, return `NOT_AVAILABLE` with the hint to open the watchlist (`ui_open_panel`) rather than creating it. Unknown symbols are detected with the app's symbol search before anything is added.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(watchlist): read and edit watchlists within the plan's limit"`

---

### Task 8: Layouts

**Files:**

- Create: `src/tools/layout/{index,page}.ts`
- Modify: `src/tools/index.ts`, `src/core/tv/page-functions.ts`, `src/core/tv/tv-window.ts`
- Test: `test/integration/tools/layout.test.ts`, `test/unit/tools/layout/*.test.ts`

**Interfaces:**

- Consumes: `TradingViewApi.getSavedCharts`, `createNewLayout`, `loadChartFromServer` / `loadLayoutFromServerByLayoutId`, `hasChartChanges`, `layoutId`, `layoutName`; plan-limit helpers.
- Produces: tools `layout_list` → `{ current: { id, name }, layouts: { id, name, modified, modifiedIso }[] }`; `layout_new` `{ name: 1–100 chars }` → `{ id, name }`; `layout_switch` `{ layoutId, confirm? }` → `{ id, name }`.

- [ ] **Step 1: Write the failing tests.**
  - `layout_new returns PLAN_LIMIT CHART_STORAGE when the saved layouts fill the plan and creates nothing`; `… refuses when the limit cannot be read`.
  - `layout_switch with unsaved changes requires confirm`; `… to the current layout changes nothing`; `… to an unknown id is INVALID_INPUT with the hint layout_list`.
  - `layout_switch waits until the new layout's chart is ready and reports it`.
- [ ] **Step 2: Run the tests to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement** with the calls and readiness signal the research notes confirm; `layout_new` and `layout_switch` run in `inPlanLimitedTurn` and pass any skip-confirm option the app offers. `layout_list` read-only.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(layout): list, create and switch layouts within the plan's limit"`

---

### Task 9: Panes and multi-chart layouts

**Files:**

- Create: `src/tools/pane/{index,page}.ts`
- Modify: `src/tools/index.ts`, `src/core/tv/page-functions.ts`
- Test: `test/integration/tools/pane.test.ts`

**Interfaces:**

- Consumes: `readChartLayout`, `resolveChartTarget`, `symbolStrategies` (Plan 1), plan-limit helpers.
- Produces: `PANE_LAYOUTS` (the layout codes the research notes confirm, with their chart counts, for example `s` 1, `2h` 2, `2v` 2, `3h` 3, `4` 4); tools `pane_list` → `{ layout, charts: { index, symbol, resolution, active, panes: { index, height, studyIds: string[], hasMainSeries }[] }[] }`; `pane_set_layout` `{ layout }`; `pane_focus` `{ chartIndex }`; `pane_set_symbol` `{ chartIndex, symbol }` (the `chart_set_symbol` path with `doNotActivateChart`).

- [ ] **Step 1: Write the failing tests.**
  - `pane_set_layout to a multi-chart layout returns PLAN_LIMIT MULTIPLE_CHARTS on a one-chart plan and changes nothing`; `… to s on a one-chart layout changes nothing`.
  - `pane_focus activates the chart` and `… an index outside the layout is INVALID_INPUT naming the range`.
  - `pane_set_symbol changes only that chart and does not activate it`.
  - `pane_list reports each chart's panes and studies`.
- [ ] **Step 2: Run the tests to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** `pane_set_layout` runs in `inPlanLimitedTurn`, compares the layout's chart count with `MULTIPLE_CHARTS`, and passes `{ withUndo: true }`. `pane_list` read-only.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(pane): list panes and change multi-chart layouts within the plan's limit"`

---

### Task 10: Tabs

**Files:**

- Create: `src/tools/tab/{index,page}.ts`
- Modify: `src/tools/index.ts`, `src/core/tv/page-functions.ts`, `src/core/connection.ts` (tab-to-target mapping), `src/tools/types.ts` (`SessionState.openedTabIds: Set<string>`), `src/server.ts`, fake window chrome DOM
- Test: `test/integration/tools/tab.test.ts`, `test/unit/core/connection*.test.ts` (extend)

**Interfaces:**

- Consumes: `windowChromePage()`, Task 3 (`clickElement` on the window target), `ConnectionManager.reset()` when the chart target changes.
- Produces: tools `tab_list` → `{ tabs: { id, index, title, active }[] }`; `tab_new` → `{ id, index }`; `tab_switch` `{ tabId? | index? }`; `tab_close` `{ tabId? | index?, confirm? }`.

- [ ] **Step 1: Write the failing tests.**
  - `tab_close refuses to close the last tab` (`NOT_AVAILABLE`, nothing clicked) and `… a tab this session did not open requires confirm`.
  - `tab_new waits for the new tab and its chart target and records it`; `tab_switch makes the tab active and the next chart call uses its target`.
  - `exactly one of tabId or index is required` (handler validation); `an unknown tab is INVALID_INPUT with the hint tab_list`.
- [ ] **Step 2: Run the tests to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement** with the window-chrome selectors of reverse-engineering §5.6 (tab, active tab, new-tab button, the close control the research notes confirm), guarded clicks only, never `require` in that page; after a switch, new or close, drop the cached chart session (`reset()`), so the next tool resolves the visible tab's target. If the research shows that `tab_new` creates a saved layout, `tab_new` checks `CHART_STORAGE` first.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(tab): list, open, switch and close tabs"`

---

### Task 11: Bar replay

**Files:**

- Create: `src/tools/replay/{index,page}.ts`, `test/helpers/fake-tv/replay.ts`
- Modify: `src/tools/index.ts`, `src/core/tv/page-functions.ts`, `src/core/tv/tv-window.ts`
- Test: `test/integration/tools/replay.test.ts`, `test/unit/tools/replay/*.test.ts`

**Interfaces:**

- Consumes: `TradingViewApi.replayApi()` (reverse-engineering §4.5), `parseTimeInput`, `pollUntil`.
- Produces: tools `replay_status` → `{ available, active, date, dateIso, autoplay, delayMs, position, realizedPL, currency }`; `replay_start` `{ date?: string | number | 'first' | 'random' }`; `replay_step` `{ bars?: 1–500 = 1 }` → `{ date, dateIso }`; `replay_autoplay` `{ enabled, speed?: one of the labels of autoplayDelayList() }`; `replay_stop` → `{ active: false }`; `replay_trade` `{ action: 'buy' | 'sell' | 'close', quantity?: > 0 }` → `{ position, realizedPL }`.

- [ ] **Step 1: Write the failing tests.**
  - **`replay_stop leaves replay while autoplay runs and after a failed step`** (autoplay stopped first; `leaveReplay` with `skipConfirm: true`; `replay_status` then reports `active: false`).
  - `replay_start with a date selects that day in milliseconds and waits until replay is ready`; `'first'` and `'random'` use the app's own selectors; `a date outside the loaded history is INVALID_INPUT`.
  - `replay_start where replay is not available fails NOT_AVAILABLE naming the resolution` (or `PLAN_LIMIT` when the research notes show a plan feature gates it).
  - `replay_step steps one bar per call of doStep and reports the date`.
  - `replay_trade is refused unless replay is active` and `acts only on the replay trading model`.
  - `replay_autoplay maps speed labels to delays and rejects unknown labels`.
- [ ] **Step 2: Run the tests to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** Watched values are read with `.value()`; no dialog: leaving uses `skipConfirm`. `replay_status` read-only.
- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(replay): start, step, play, trade on paper and stop bar replay"`

---

### Task 12: Prompt, core profile and usage examples

**Files:**

- Modify: `src/prompts/index.ts`, tool definitions (`core` flags), `test/unit/tools/registry.test.ts`, `packages/server/scripts/docs/scenarios.ts`, `docs/examples.md` (regenerated), `README.md`
- Test: `test/integration/prompts.test.ts`, `test/integration/docs-examples.test.ts`

**Interfaces:**

- Produces: prompt `replay_practice_session` `{ date?, symbol?, timeframe? }`; the Plan 3 core set: `drawing_create`, `drawing_list`, `alert_create`, `alert_list`, `watchlist_get`, `watchlist_add`, `replay_start`, `replay_step`, `replay_stop`, `screenshot_capture` (the core profile grows from 29 to 39 tools).

- [ ] **Step 1: Write the failing tests.**
  - `the core profile is exactly the 39 pinned tools`.
  - `replay_practice_session names replay_start, replay_step, replay_trade, replay_status and replay_stop and tells the assistant to stop replay at the end`; every tool name in it exists.
  - The docs test fails until `docs/examples.md` holds the new scenarios.
- [ ] **Step 2: Run the tests to verify they fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** Add scenarios: draw a support line and list drawings; create an alert on a full plan (the `PLAN_LIMIT` result) and on a plan with room; add symbols to the watchlist in bulk; a replay practice session (start, step, buy, close, stop); a screenshot (the page shows the JSON block and a note in place of the image). Update the README "Use it" section and its prompt list.
- [ ] **Step 4: Run the tests to verify they pass.** Run: `pnpm docs:examples && pnpm -C packages/server exec vitest run test/integration/prompts.test.ts test/integration/docs-examples.test.ts test/unit/tools/registry.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "docs: add interaction examples and the replay practice prompt"`

---

### Task 13: E2E against the real app, observations, and docs

**Files:**

- Create: `test/e2e/{drawing,alert,watchlist,layout,tab,replay,screenshot,ui}.e2e.test.ts`
- Modify: `test/e2e/setup.ts`, `docs/reverse-engineering.md` (§5, §6 matrix, §12 answered), `docs/testing.md`, spec §7 rows, and the fakes where an observation proves them wrong

**Interfaces:**

- Consumes: every tool of this plan; `planLimitSkipReason`, `optedIn`, `prepareChartChange`, `addThenCleanUp` (Plan 2).

- [ ] **Step 1: Write the E2E suites** with these rules: drawings — create one of each of three shapes, read them back, remove them, never touch other drawings; alerts — only with room under `SERVER_SIDE_ALERTS`, a far-away price, a short expiration and a recognizable message, deleted in `finally`; watchlist — add and remove one symbol that is not listed yet, only with room; layouts — list (names never printed), `layout_new` expects `PLAN_LIMIT` when full and is opt-in (`TV_E2E_ALLOW_LAYOUTS=1`) otherwise; panes — list, focus 0, `pane_set_layout` multi expects `PLAN_LIMIT` on a one-chart plan; tabs — list, and new-switch-close of the test's own tab only when it leaves nothing behind (else opt-in `TV_E2E_ALLOW_TABS=1`); replay — on a daily chart: start, step, autoplay on and off, status, paper trade buy and close only if the research confirms the replay model is isolated, stop in `finally`, chart restored; screenshot — chart and window, dimensions only, nothing written; UI — find elements, hover a header button, open and close the symbol search with Escape, type into its field, open and close the watchlist panel (restoring its state); `ui_evaluate` only when `TV_MCP_ALLOW_EVAL=true` is set for the run.
- [ ] **Step 2: Run against the real app.** Run: `TV_E2E=1 pnpm test:e2e`. Expected: PASS with plan-limit and opt-in skips named. Record before/after state (drawing count, alert count, watchlist size, layout, tab count, replay off, panel state, chart state).
- [ ] **Step 3: Record observations** in the report and `docs/reverse-engineering.md`: reverse-engineering §12 questions 3, 4, 6, 7, 10, 11, 13 and 14; the drawing creation return and undo; the alert payload; tab-to-target mapping; replay readiness and leaving; `takeClientScreenshot`. Fix any contradicted assumption with a focused `fix(...)` commit and a fake update.
- [ ] **Step 4: Update `docs/testing.md`** (what Plan 3 E2E may touch, the new opt-ins) and the spec §7 rows to the shipped inputs (`confirm?` on `drawing_remove`, `alert_delete`, `watchlist_remove`, `tab_close`, `layout_switch`).
- [ ] **Step 5: Commit.** `git commit -m "test: add interaction E2E suites with plan-aware skips"` (observation fixes in their own commits).
