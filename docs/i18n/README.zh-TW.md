# tradingview-desktop-mcp

[English](../../README.md) · [简体中文](README.zh-CN.md) · **繁體中文** · [日本語](README.ja.md) · [한국어](README.ko.md) · [Türkçe](README.tr.md) · [Русский](README.ru.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Українська](README.uk.md) · [Polski](README.pl.md) · [Português (Brasil)](README.pt-BR.md) · [العربية](README.ar.md) · [فارسی](README.fa.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Ελληνικά](README.el.md) · [മലയാളം](README.ml.md) · [Roman Urdu](README.ur-Latn.md) · [Română](README.ro.md)

[![npm](https://img.shields.io/npm/v/tradingview-desktop-mcp)](https://www.npmjs.com/package/tradingview-desktop-mcp)
[![CI](https://github.com/Mochamad-Rizky/tradingview-desktop-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Mochamad-Rizky/tradingview-desktop-mcp/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/Mochamad-Rizky/tradingview-desktop-mcp/graph/badge.svg)](https://codecov.io/gh/Mochamad-Rizky/tradingview-desktop-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../../LICENSE)

> 本文是[英文 README](../../README.md) 的翻譯。若兩者內容有出入，以英文版為準。

<p align="center">
  <a href="../media/promo.mp4"><img src="../media/teaser.gif" width="49%" alt="概覽影片：助理讀取圖表、畫出一條支撐線、撰寫 Pine Script 並設定價格警示"></a>
  <a href="../media/tutorial.mp4"><img src="../media/tutorial-poster.jpg" width="49%" alt="安裝教學：五個步驟完成設定"></a>
</p>

<p align="center">
  <a href="../media/promo.mp4"><b>▶ 觀看概覽影片</b></a> (0:48) &nbsp;·&nbsp;
  <a href="../media/tutorial.mp4"><b>▶ 觀看安裝教學</b></a> (1:53)<br>
  <sub>兩部影片使用的都是虛構的圖表，並非真實的市場資料。</sub>
</p>

這是一個 [MCP](https://modelcontextprotocol.io) 伺服器，讓 AI 助理能夠讀取並控制你電腦上的 TradingView Desktop 應用程式。它透過 Chrome DevTools Protocol 操控你已經登入的應用程式，使用的是應用程式以 `--remote-debugging-port` 啟動時開啟的偵錯連接埠。它只會自動化本機的應用程式：不會替你登入、不會繞過訂閱方案的限制，也不會呼叫 TradingView 的伺服器。

> **狀態：1.0 之前的預覽版本。** 在 1.0 之前，工具名稱與選項可能會有所變動。請依照下文從 npm 安裝此套件，或[從原始碼](#quick-start-from-source)執行伺服器。目前已在 macOS 上測試過；Windows 與 Linux 則盡力支援。

伺服器提供以下工具：應用程式工具（啟動、健康檢查、探索、介面狀態、方案限制、重新連線）、圖表工具（狀態、商品代碼、時間週期、圖表類型、可見範圍、捲動）、市場資料工具（K 棒、報價、商品資訊與搜尋）、指標工具（列出、搜尋、新增、移除、輸入參數、顯示狀態、數值）、Pine Script 工具（編輯器與已儲存的腳本、編譯、搭配規則式自動修正的智慧編譯、離線分析、主控台，以及腳本所繪製的線條、標籤、方框與表格）、策略測試器工具（結果、交易、權益曲線）、繪圖、警示與觀察清單工具，版面配置、多圖表與分頁工具，K 棒重播，螢幕截圖，底層介面工具（點擊、滑鼠懸停、輸入文字、按鍵、捲動、尋找、面板、全螢幕，以及在你允許時於圖表頁面中執行 JavaScript），還有 `batch_run`，可以在一次呼叫中執行多個工具。它也提供資源（應用程式健康狀態、圖表狀態與 K 棒、Pine 原始碼與最近一次的編譯結果、策略報告、目前的觀察清單），每個資源都會與共用其資料的工具一起提供，另外還有五個適用於常見工作的提示詞。一個網頁儀表板可以即時顯示呼叫，並能手動執行工具（請參閱[儀表板](#dashboard)）。

目錄：[請 AI 應用程式幫你安裝](#install-by-asking-your-ai-app)、[安裝](#install)、[連接你的 AI 應用程式](#connect-your-ai-app)、[遠端用戶端與通道](#remote-clients-and-tunnels)、[從原始碼快速開始](#quick-start-from-source)、[使用方式](#use-it)、[疑難排解](#troubleshooting)、[儀表板](#dashboard)、[參與貢獻](#contributing)。

## <a id="install-by-asking-your-ai-app"></a>請 AI 應用程式幫你安裝

你不需要自己輸入任何指令。只要你的 AI 應用程式能在你的電腦上執行指令（Claude Code、Cursor、VS Code、Windsurf、Gemini CLI 與 Codex CLI 都可以），它就能替你完成設定。首先：

1. 安裝 [TradingView Desktop](https://www.tradingview.com/desktop/) 並登入。
2. 如果還沒有安裝 [Node.js](https://nodejs.org)，請先安裝（LTS 版本）。

接著複製下面這段提示詞，貼到你的 AI 應用程式中並送出：

```text
請幫我安裝 TradingView MCP 伺服器。它是 npm 套件 tradingview-desktop-mcp
(https://github.com/Mochamad-Rizky/tradingview-desktop-mcp)。請依照以下步驟進行，並用淺顯易懂的話
向我說明每一個步驟：

1. 確認是否已安裝 Node.js 20.19 或更新版本。如果沒有，請停下來並告訴我該如何安裝。
2. 執行 "npx -y tradingview-desktop-mcp config <client>"，其中 <client> 是你目前所在的應用程式
   （claude-code、cursor、vscode、windsurf、gemini-cli 或 codex-cli）。依照它輸出的說明把伺服器
   加入我的設定中，並保留設定裡原有的其他伺服器。
3. 用 "npx -y tradingview-desktop-mcp launch" 啟動 TradingView。如果它表示 TradingView 已經在執行
   但沒有開啟偵錯連接埠，請先詢問我，只有在我同意之後才加上 --restart 再執行一次，因為這會關閉
   TradingView，我可能會遺失尚未儲存的變更。
4. 執行 "npx -y tradingview-desktop-mcp doctor"，並告訴我是否所有檢查都通過。如果圖表檢查失敗，
   請提醒我在 TradingView 中把圖表分頁切換到最前面。
5. 告訴我是否需要重新啟動你或開啟新的對話，TradingView 的工具才會出現。
```

完成之後，如果它提示你需要，就重新啟動應用程式或開啟新的對話，然後問它：「確認 TradingView 是否已連線。」接著試試[下方的提示詞](#try-these-prompts)。

你用的是 Claude Desktop 嗎？它無法執行指令，但 Claude Code、Cursor 以及上面提到的其他應用程式可以替你設定：在提示詞的最後加上「請為 Claude Desktop 進行設定（config claude-desktop），而不是為目前這個應用程式設定。」。ChatGPT 與 OpenAI API 需要一個通道，這必須由你手動設定（請參閱[遠端用戶端與通道](#remote-clients-and-tunnels)）。如果助理卡住了，請自行依照下面的步驟操作。

## <a id="install"></a>安裝

你需要：

- TradingView Desktop，已安裝並登入。
- Node.js 20.19 或更新版本，它會提供 `npx`。

不需要安裝其他任何東西：下列用戶端會以 `npx -y tradingview-desktop-mcp` 啟動伺服器，第一次使用時會自動下載此套件。請以開啟偵錯連接埠的方式啟動 TradingView。`launch` 指令會找到應用程式並以這種方式啟動它：

```sh
npx -y tradingview-desktop-mcp launch
```

TradingView 只允許同時執行一個實例。如果它已經在執行但沒有開啟偵錯連接埠，`launch` 會停止並告知原因；`launch --restart` 會正常結束它，再以開啟連接埠的方式重新啟動，TradingView 可能會先詢問你是否要儲存變更。確認伺服器能否連線到應用程式：

```sh
npx -y tradingview-desktop-mcp doctor
```

當圖表分頁位於背景，也就是在「新分頁」頁面或其他沒有圖表的分頁後面時，`doctor` 的圖表檢查會失敗，所以請把圖表分頁切換到最前面。`npx -y tradingview-desktop-mcp --help` 會列出所有選項，[.env.example](../../.env.example) 則列出了環境變數。

## <a id="connect-your-ai-app"></a>連接你的 AI 應用程式

`config <client>` 會輸出某個用戶端的設定片段，並說明它應該放在哪裡。下面每一篇教學都包含相同的設定片段、該應用程式的操作步驟，以及無法正常運作時該怎麼處理。

| 用戶端                                         | 輸出設定片段                                           |
| ---------------------------------------------- | ------------------------------------------------------ |
| [Claude Desktop](../clients/claude-desktop.md) | `npx -y tradingview-desktop-mcp config claude-desktop` |
| [Claude Code](../clients/claude-code.md)       | `npx -y tradingview-desktop-mcp config claude-code`    |
| [Cursor](../clients/cursor.md)                 | `npx -y tradingview-desktop-mcp config cursor`         |
| [VS Code](../clients/vscode.md)                | `npx -y tradingview-desktop-mcp config vscode`         |
| [Windsurf](../clients/windsurf.md)             | `npx -y tradingview-desktop-mcp config windsurf`       |
| [Gemini CLI](../clients/gemini-cli.md)         | `npx -y tradingview-desktop-mcp config gemini-cli`     |
| [Codex CLI](../clients/codex-cli.md)           | `npx -y tradingview-desktop-mcp config codex-cli`      |
| [ChatGPT](../clients/chatgpt.md)               | `npx -y tradingview-desktop-mcp config chatgpt`        |
| [OpenAI API](../clients/openai-api.md)         | `npx -y tradingview-desktop-mcp config openai-api`     |

預設的傳輸方式是 stdio，此時 stdout 只承載 MCP 訊息，記錄則輸出到 stderr。前七個用戶端會自行啟動伺服器。在 Windows 上，無法直接啟動 `npx` 的用戶端需要使用 `cmd /c npx` 的形式，`config` 在 Windows 上執行時（或加上 `--platform win32` 時）會輸出這種形式。`--profile` 會把一個[工具設定檔](#tool-profiles)傳遞給伺服器。

### <a id="remote-clients-and-tunnels"></a>遠端用戶端與通道

ChatGPT 與 OpenAI API 無法在你的電腦上啟動程式。它們會透過一個公開的 HTTPS 位址連線到伺服器，所以你必須以 HTTP 方式執行伺服器，並在它前面架設一個通道。這等於是把一台能控制你已登入的 TradingView 的伺服器放上網際網路：請使用 `--profile readonly` 與一組高強度的權杖（`TV_MCP_AUTH_TOKEN`），把通道的公開主機名稱填入 `--allowed-hosts`（`TV_MCP_ALLOWED_HOSTS`），並使用 `--no-dashboard`，以免儀表板的檔案透過通道對外提供。[ChatGPT](../clients/chatgpt.md) 與 [OpenAI API](../clients/openai-api.md) 的教學會逐步說明整個流程，[SECURITY.md](../../SECURITY.md#tunnels-and-remote-clients) 則列出了唯讀權杖仍然能存取的內容。

## <a id="quick-start-from-source"></a>從原始碼快速開始

如果要執行 checkout 下來的原始碼而不是已發佈的套件，你需要 Node.js 24 來建置伺服器（`nvm use` 會讀取 `.nvmrc`），以及 [pnpm](https://pnpm.io)，其版本由 `package.json` 鎖定。建置好的伺服器可以在 Node.js 20.19 或更新版本上執行。

```sh
git clone https://github.com/Mochamad-Rizky/tradingview-desktop-mcp.git
cd tradingview-desktop-mcp
pnpm install && pnpm build
node packages/server/dist/cli.js launch
node packages/server/dist/cli.js doctor
```

`node packages/server/dist/cli.js config <client> --local` 會輸出適用於這份 checkout 的用戶端設定片段，以 `node` 和 `cli.js` 的絕對路徑取代 `npx`。對於使用 JSON 設定的用戶端，設定項目如下所示：

```json
{
  "mcpServers": {
    "tradingview": {
      "command": "node",
      "args": ["/absolute/path/to/tradingview-desktop-mcp/packages/server/dist/cli.js"]
    }
  }
}
```

此外還有一種 HTTP 傳輸方式（`--transport http`）；使用之前請先閱讀 [SECURITY.md](../../SECURITY.md)。

## <a id="use-it"></a>使用方式

依照上文連接一個 MCP 用戶端，在 TradingView 以開啟偵錯連接埠的方式執行時，用日常的話說出你想做的事就可以了。助理會自行挑選並呼叫工具，所以你不需要知道它們的名稱。[工具參考](../tools.md)列出了每個工具的輸入參數及其所屬的設定檔。

### <a id="try-these-prompts"></a>試試這些提示詞

下面每一條提示詞都對應 [docs/examples.md](../examples.md) 中的一個範例，那裡展示了助理發出的工具呼叫及其結果：超過三項的清單已截斷，省略了每次呼叫的耗時（`durationMs`），螢幕截圖則以註記標示而不直接顯示。下面的摘錄是這些結果中的部分行，`…` 表示此處省略了結果中其他部分的行。這些數值都是合成的：它們來自一個模擬的 TradingView 應用程式與一張虛構的 NASDAQ:AAPL 圖表，因此沒有任何內容是市場資料，也沒有任何內容來自帳戶；結果的結構與伺服器實際回傳的一致，不過回測範例背後的策略測試器報告尚未從真實的應用程式中讀取過。

**「我的圖表上顯示的是什麼？告訴我商品代碼、時間週期，以及上面套用了哪些指標。」** 助理會用 `chart_get_state` 讀取圖表（[詳細說明](../examples.md#1-read-the-chart)）：

```json
"symbol": "NASDAQ:AAPL",
"resolution": "1D",
"chartTypeName": "candles",
```

**「顯示最近 3 根日 K 棒給我看。」** 它會用 `data_get_ohlcv` 讀取 K 棒（[詳細說明](../examples.md#3-read-the-last-candles)）：

```json
"timeIso": "2024-10-27T00:00:00Z",
"open": 103.58,
"close": 103.42,
```

**「在我的圖表上加入 MACD。」** 如果圖表上的指標數量已經達到方案允許的上限，`indicator_add` 不會新增任何指標並會回報該限制，而要移除你的某個指標來騰出空間，則需要經過你的確認（[詳細說明](../examples.md#5-add-an-indicator-to-a-full-chart)）：

```json
"code": "PLAN_LIMIT",
"message": "The chart holds as many indicators as the plan allows (2)",
```

**「寫一個 Pine Script 指標，畫出收盤價的 9 期與 21 期移動平均線，並確認它能否編譯成功。」** 它會用 `pine_new` 把腳本放進 Pine 編輯器，再用 `pine_compile` 編譯（[詳細說明](../examples.md#6-write-and-compile-a-pine-script)）：

```json
"success": true,
"errors": [],
"warnings": [],
```

**「我 Pine 編輯器裡的腳本無法編譯，你可以幫我修好嗎？」** `pine_smart_compile` 會編譯腳本，針對它認得的錯誤（例如 v6 腳本中使用了 Pine v4 的名稱）套用規則式修正，然後再編譯一次，整個過程不會更動編輯器中的內容（[詳細說明](../examples.md#7-fix-a-pine-script-with-smart-compile)）：

```json
"message": "Could not find function or function reference 'study'",
…
"applied": ["Replace study( with indicator(", "Replace rsi( with ta.rsi("]
…
"writtenBack": false
```

**「我圖表上的策略回測表現如何？」** 它會用 `strategy_get_results` 與 `strategy_get_trades` 讀取策略測試器（[詳細說明](../examples.md#8-read-backtest-results)）：

```json
"netProfit": 155,
"totalTrades": 3,
"percentProfitable": 66.67,
"profitFactor": 4.1,
```

**「在我的圖表上 102.80 的位置畫一條支撐線。」** 它會用 `drawing_create` 畫一條水平線，`drawing_list` 會把它和你自己的繪圖一起列出，並標示為由本工作階段所繪製（[詳細說明](../examples.md#9-draw-a-support-line)）：

```json
"id": "DRW001",
"shape": "horizontal_line",
"text": "Support",
"createdByServer": true
```

**「蘋果股價穿越 110 時通知我。」** `alert_create` 會在你的 TradingView 帳戶中設定一個價格警示（[詳細說明](../examples.md#10-create-a-price-alert)）。如果方案中的警示數量已經達到上限，它不會建立任何警示並會回報該限制，`alert_list` 則會列出佔滿額度的那些警示（[詳細說明](../examples.md#11-create-an-alert-when-the-plan-is-full)）：

```json
"symbol": "NASDAQ:AAPL",
"condition": "crossing",
"price": 110,
"expirationIso": "2024-11-26T00:00:00Z"
```

**「把這些商品加入我的觀察清單：NYSE:IBM、FX:EURUSD、NASDAQ:MSFT 和 NASDAQ:MSTF。」** `watchlist_add_bulk` 會用 TradingView 的商品搜尋逐一確認每個代碼，加入新的商品，並說明略過其他商品的原因（[詳細說明](../examples.md#12-add-symbols-to-a-watchlist)）：

```json
"added": ["NYSE:IBM", "FX:EURUSD"],
…
{ "symbol": "NASDAQ:MSFT", "reason": "already_listed" },
{ "symbol": "NASDAQ:MSTF", "reason": "unknown" }
```

**「讓我在圖表上從 2024-06-03 開始用 K 棒重播練習：往前推進五根 K 棒，告訴我現在到哪裡了，然後結束重播。」** 它會用 `replay_start` 開始 K 棒重播，用 `replay_step` 推進，用 `replay_status` 讀取重播目前的位置，再用 `replay_stop` 離開重播。整個過程不會進行任何交易：沒有任何工具會下單（[詳細說明](../examples.md#13-practice-with-bar-replay)）：

```json
"dateIso": "2024-06-07T00:00:00Z",
"stepped": 5,
…
"position": null,
"realizedPL": null
```

**「幫我的圖表截個圖。」** `screenshot_capture` 會把截圖連同尺寸一起以圖片形式交給助理，不會寫入任何東西到磁碟（[詳細說明](../examples.md#14-take-a-screenshot)）：

```json
"data": { "target": "chart", "format": "jpeg", "width": 1180, "height": 640, "bytes": 3100 },
"meta": { "via": "cdp", "warnings": [] }
```

伺服器也內建五個提示詞，支援 MCP 提示詞的用戶端會將它們列出供你選擇：`analyze_current_chart`、`multi_timeframe_review`、`write_and_backtest_strategy`、`debug_pine_script` 與 `replay_practice_session`。每個提示詞都會告訴助理要呼叫哪些工具、依什麼順序呼叫，以及最後要回報什麼。`replay_practice_session` 會在 K 棒重播上進行一次練習：助理一根一根 K 棒地推進過去的行情，在每一步詢問你要做多、做空還是觀望，依照從圖表上讀取的價格為這些假設性的交易記帳，並計算它們的損益。它會先確認你是否有正在進行的重播，如果有，會在做任何變更之前先問你要如何處理；結束時它只會停止自己啟動的重播，絕不會停止你的重播。

### <a id="safety"></a>安全性

會變更你的圖表、腳本或帳戶的工具，對於原本就屬於你的內容都會很謹慎。取代 Pine 編輯器中尚未儲存的文字（本次伺服器工作階段自己在那裡所做的未儲存編輯除外）、為不是本工作階段建立的腳本儲存新版本，以及移除圖表上原本就有的指標，都需要 `confirm: true`，而助理只應在你同意之後才傳入此參數。以下操作同樣需要確認：移除不是本工作階段建立、加入或開啟的繪圖、警示、觀察清單商品或分頁，移除圖表上的所有繪圖，從有未儲存變更的版面配置切換出去，以及切換到圖表數量少於目前分頁所顯示數量的多圖表版面配置（因為下次儲存時會捨棄多出來的圖表）。方案限制（例如圖表上的指標數量、已儲存腳本的數量、警示數量或版面配置中的圖表數量）會在新增任何內容之前先行檢查，並以附帶限制值的 `PLAN_LIMIT` 錯誤回報；如果在你的 TradingView 版本上無法讀取該限制，工具不會執行任何動作並會說明原因。伺服器不會繞過任何限制。這些工具會事先檢查哪些操作會讓 TradingView 跳出升級對話框或它自己的其他對話框，並拒絕執行，但仍有少數提示是這些檢查無法預見的：在圖表數量上限較低的方案下切換到已儲存的多圖表版面配置、切換到被 TradingView 伺服器以超出限制為由拒絕的版面配置，或是切換到 TradingView 自己維護的清單標示為超出限制、而 `layout_list` 並未標示的版面配置時，`layout_switch` 可能會遇到升級提示；`layout_new` 可能會在通過檢查之後遇到 TradingView 拒絕建立新版面配置的訊息；對於需要比 TradingView 的等待時間更久才能判斷其版面配置是否有未儲存變更的頁面，或回報正在錄影的頁面，`tab_close` 可能會遇到「關閉分頁？」對話框。底層的 `ui_*` 工具會依照你的要求點擊與輸入，因此依設計本來就可能開啟 TradingView 的對話框。伺服器不會刪除或重新命名任何腳本。

沒有任何工具會下單：K 棒重播僅供練習，助理會把練習交易記錄在對話中。螢幕截圖會以圖片形式傳送給用戶端，伺服器不會把任何截圖寫入磁碟。`ui_evaluate` 用來在圖表頁面中執行 JavaScript，預設為關閉，除非你以 `--allow-eval`（`TV_MCP_ALLOW_EVAL=true`）啟動伺服器。

### <a id="tool-profiles"></a>工具設定檔

預設情況下，伺服器會提供全部 83 個工具（`--profile full`）。有些用戶端只接受有限數量的工具（Cursor 在超過 40 個時會發出警告）。對於這類用戶端，`--profile core` 提供精簡過的 40 個核心工具，`--profile readonly` 則只提供 37 個讀取類工具。`--tools` 接受像 `chart_*,data_*` 這樣的名稱模式，用來進一步縮小設定檔的範圍：工具必須既在設定檔之中，又符合某個模式，因此 `--profile core --tools 'pine_*'` 仍然不會包含 `pine_open` 與 `pine_save`，因為它們不是核心工具；使用預設設定檔時，只靠 `--tools` 就能選定工具。有些描述與提示中提到了 `core` 所不包含的工具，例如 `pine_open` 與 `pine_save`，在 `core` 設定檔下助理無法呼叫它們。資源會跟著工具走：每個資源只會與共用其資料的工具一起提供，例如 `tradingview://pine/source` 會與 `pine_get_source` 一起提供，所以 `--tools 'chart_*'` 會提供圖表狀態，但不會提供任何與 Pine 編輯器相關的內容。

[工具參考](../tools.md)列出了每個工具的輸入參數及其所屬的設定檔。

## <a id="troubleshooting"></a>疑難排解

[docs/troubleshooting.md](../troubleshooting.md) 說明了每個錯誤代碼，以及在找不到 TradingView、偵錯連接埠被佔用、用戶端沒有顯示工具或通道拒絕請求時該怎麼處理。遇到問題時，第一件要做的事就是執行 `npx -y tradingview-desktop-mcp doctor`。

## <a id="dashboard"></a>儀表板

伺服器內建一個網頁儀表板，可以用來觀察你的助理正在做什麼，也可以手動試用某個工具。它不需要另外安裝：已發佈的套件中就包含它，而 `pnpm build` 會把它建置進 checkout 原始碼的伺服器中。

![狀態頁面：TradingView 可連線、已找到圖表且應用程式已就緒，伺服器的相關資訊，以及方案限制](../images/dashboard-status.png)

### <a id="open-it"></a>開啟儀表板

- **HTTP 傳輸方式：** 帶著權杖啟動伺服器，然後開啟 `http://127.0.0.1:8787/`。在這種模式下儀表板預設為開啟；`--no-dashboard`（`TV_MCP_DASHBOARD=false`）可以將其關閉。

  ```sh
  TV_MCP_AUTH_TOKEN="$(openssl rand -hex 32)" npx -y tradingview-desktop-mcp --transport http
  ```

  如果使用的是 checkout 的原始碼，請改為執行 `node packages/server/dist/cli.js --transport http`。

- **與 stdio 並用：** 透過 stdio 啟動伺服器的 MCP 用戶端同樣可以使用儀表板。在它的設定中加入 `--dashboard`（`TV_MCP_DASHBOARD=true`）與 `TV_MCP_AUTH_TOKEN`。儀表板會監聽自己的位址，除非你設定了 `--host` 與 `--port`，否則就是 `127.0.0.1:8787`，而且不提供 `/mcp`。如果沒有權杖，或連接埠已被佔用，儀表板會維持關閉，伺服器會記錄一則警告，但 MCP 伺服器會繼續執行。用戶端發出的呼叫會顯示在即時記錄中。

伺服器啟動時會在 stderr 上印出儀表板的位址。它絕不會印出權杖。

### <a id="the-token"></a>權杖

頁面在顯示任何內容之前，會先要求輸入權杖（`TV_MCP_AUTH_TOKEN`）。你可以直接貼上，或是開啟一次 `http://127.0.0.1:8787/#token=<token>`：頁面會從網址片段中讀取權杖，並將其從網址列中移除，而片段永遠不會傳送到伺服器。頁面會把權杖存放在 `sessionStorage` 中，因此關閉分頁後權杖就會消失；它只會以 `Authorization: Bearer <token>` 的形式傳送權杖，絕不會放在網址中。當伺服器以另一組權杖重新啟動後，頁面會再次要求輸入。請參閱 [SECURITY.md](../../SECURITY.md#the-dashboard)。

### <a id="what-it-shows"></a>顯示內容

![即時記錄：工具呼叫的表格，最新的排在最前面，列出時間、工具、來源、狀態與耗時，上方是搜尋框與篩選器](../images/dashboard-log.png)

- **Status**（狀態）顯示 TradingView 是否可連線（無法連線時還會告訴你如何啟動它）、伺服器的執行方式、方案限制以及最近的呼叫。
- **Log**（記錄）即時串流伺服器執行的每一次工具呼叫，不論它是由 MCP 用戶端還是儀表板發起，並支援依工具名稱篩選、暫停、清除以及檢視每次呼叫的詳細資料。連線中斷後，它會顯示「Reconnecting…」，並從中斷的地方接續。儀表板每個開啟的分頁都會與伺服器維持一條事件串流，而瀏覽器對同一主機大約只允許六個連線，所以開啟很多儀表板分頁時，新的分頁可能要等待空出的連線：請關閉不用的分頁。
- **Tools**（工具）列出伺服器提供的工具及其輸入參數，並可以手動執行其中一個。結果會依回傳時的原樣顯示，較長的 JSON 會收合在「Show all」後面，圖片則直接以圖片顯示。

![工具頁面：左側是附有搜尋框與篩選器的工具清單，右側是 chart_get_state 及其描述、相關資訊與輸入欄位](../images/dashboard-tools.png)

從儀表板發起的執行是真正的工具呼叫。它與 MCP 呼叫經過同一個登錄表，因此同樣適用相同的 schema、設定檔、`confirm` 規則與方案限制檢查，也會出現在記錄中。在執行任何非唯讀的工具之前，儀表板都會請你確認。

### <a id="the-api"></a>API

頁面透過一個小型 API 與伺服器溝通，你也可以用 `curl` 搭配權杖來呼叫它。每個路由都需要 `Authorization: Bearer <token>`，伺服器也會像處理 `/mcp` 一樣檢查 `Host` 與 `Origin`。

| 路由                     | 功能                                                         |
| ------------------------ | ------------------------------------------------------------ |
| `GET /api/info`          | 版本、傳輸方式、設定檔、工具數量與啟動時間                   |
| `GET /api/health`        | 健康報告：TradingView 是否可連線                             |
| `GET /api/tools`         | 目前提供的工具，以及它們的 schema 與註解                     |
| `POST /api/tools/<name>` | 以 `{"arguments": {...}}` 執行一個工具，來源記為 `dashboard` |
| `GET /api/events`        | 工具呼叫的伺服器推送事件（SSE）；`?limit=` 設定要重播幾筆    |

頁面本身的檔案位於 `/`，不需要權杖，也不包含任何資料。

## <a id="contributing"></a>參與貢獻

本機開發環境的設定、測試層級、commit 慣例以及發佈流程，請參閱 [CONTRIBUTING.md](../../CONTRIBUTING.md)；測試指南請參閱 [docs/testing.md](../testing.md)。如需回報安全性漏洞，請依照 [SECURITY.md](../../SECURITY.md) 中的說明進行。

## <a id="disclaimer"></a>免責聲明

本專案與 TradingView, Inc. 沒有任何關係，也未獲得其認可或贊助。TradingView 是其所有者的商標。本文的任何內容皆不構成投資建議。這些工具會改變應用程式所顯示的內容，並可能操作到它的控制項，因此你必須為自己所自動化的操作負責，並遵守 TradingView 的使用條款。

## <a id="license"></a>授權條款

以 [MIT 授權條款](../../LICENSE)釋出。
