# tradingview-desktop-mcp

[English](../../README.md) · **简体中文** · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Türkçe](README.tr.md) · [Русский](README.ru.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Українська](README.uk.md) · [Polski](README.pl.md) · [Português (Brasil)](README.pt-BR.md) · [العربية](README.ar.md) · [فارسی](README.fa.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Ελληνικά](README.el.md) · [മലയാളം](README.ml.md) · [Roman Urdu](README.ur-Latn.md) · [Română](README.ro.md)

[![npm](https://img.shields.io/npm/v/tradingview-desktop-mcp)](https://www.npmjs.com/package/tradingview-desktop-mcp)
[![CI](https://github.com/Mochamad-Rizky/tradingview-desktop-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Mochamad-Rizky/tradingview-desktop-mcp/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/Mochamad-Rizky/tradingview-desktop-mcp/graph/badge.svg)](https://codecov.io/gh/Mochamad-Rizky/tradingview-desktop-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../../LICENSE)

> 本文是[英文 README](../../README.md) 的翻译。如两者内容有出入，以英文版为准。

<p align="center">
  <a href="../media/promo.mp4"><img src="../media/teaser.gif" width="49%" alt="概览视频：助手读取图表、画出一条支撑线、编写 Pine Script 并设置价格警报"></a>
  <a href="../media/tutorial.mp4"><img src="../media/tutorial-poster.jpg" width="49%" alt="安装教程：五步完成设置"></a>
</p>

<p align="center">
  <a href="../media/promo.mp4"><b>▶ 观看概览视频</b></a> (0:48) &nbsp;·&nbsp;
  <a href="../media/tutorial.mp4"><b>▶ 观看安装教程</b></a> (1:53)<br>
  <sub>两个视频使用的都是虚构的图表，并非真实行情数据。</sub>
</p>

这是一个 [MCP](https://modelcontextprotocol.io) 服务器，让 AI 助手可以读取并控制你本机上的 TradingView Desktop 应用。它通过 Chrome DevTools Protocol 驱动你已经登录的应用，使用的是应用以 `--remote-debugging-port` 启动时打开的调试端口。它只自动化本地应用：不会替你登录，不会绕过订阅方案的限制，也不会调用 TradingView 的服务器。

> **状态：1.0 之前的预发布版本。** 在 1.0 之前，工具名称和选项可能会有变动。请按下文所述从 npm 安装此包，或[从源码](#quick-start-from-source)运行服务器。目前已在 macOS 上测试过；Windows 和 Linux 为尽力支持。

服务器提供以下工具：应用工具（启动、健康检查、发现、界面状态、方案限制、重新连接）、图表工具（状态、商品代码、时间周期、图表类型、可见范围、滚动）、行情数据工具（K 线、报价、商品信息与搜索）、指标工具（列出、搜索、添加、移除、输入参数、可见性、数值）、Pine Script 工具（编辑器与已保存的脚本、编译、带基于规则的自动修复的智能编译、离线分析、控制台，以及脚本绘制的线条、标签、方框和表格）、策略测试器工具（结果、交易、资金曲线）、绘图、警报与自选表工具，布局、多图表与标签页工具，K 线回放，截图，底层界面工具（点击、悬停、输入文字、按键、滚动、查找、面板、全屏，以及在你允许时于图表页面中运行 JavaScript），还有 `batch_run`，可以在一次调用中运行多个工具。它还提供资源（应用健康状态、图表状态与 K 线、Pine 源码与最近一次编译结果、策略报告、当前自选表），每个资源都与共享其数据的工具一同提供，另外还有五个用于常见任务的提示词。一个 Web 仪表板可以实时显示调用，并可手动运行工具（参见[仪表板](#dashboard)）。

目录：[让 AI 应用帮你安装](#install-by-asking-your-ai-app)、[安装](#install)、[连接你的 AI 应用](#connect-your-ai-app)、[远程客户端与隧道](#remote-clients-and-tunnels)、[从源码快速开始](#quick-start-from-source)、[使用](#use-it)、[故障排除](#troubleshooting)、[仪表板](#dashboard)、[参与贡献](#contributing)。

## <a id="install-by-asking-your-ai-app"></a>让 AI 应用帮你安装

你不需要亲自输入任何命令。只要你的 AI 应用能在你的电脑上运行命令（Claude Code、Cursor、VS Code、Windsurf、Gemini CLI 和 Codex CLI 都可以），它就能替你完成安装。首先：

1. 安装 [TradingView Desktop](https://www.tradingview.com/desktop/) 并登录。
2. 如果还没有安装 [Node.js](https://nodejs.org)，请安装它（LTS 版本）。

然后复制下面这段提示词，粘贴到你的 AI 应用中并发送：

```text
请帮我安装 TradingView MCP 服务器。它是 npm 包 tradingview-desktop-mcp
(https://github.com/Mochamad-Rizky/tradingview-desktop-mcp)。请按照以下步骤操作，并用简单易懂的话
向我解释每一步：

1. 检查是否已安装 Node.js 20.19 或更高版本。如果没有，请停下来并告诉我如何安装。
2. 运行 "npx -y tradingview-desktop-mcp config <client>"，其中 <client> 是你当前所在的应用
   （claude-code、cursor、vscode、windsurf、gemini-cli 或 codex-cli）。按照它输出的说明把服务器
   添加到我的配置中，并保留配置里已有的其他服务器。
3. 用 "npx -y tradingview-desktop-mcp launch" 启动 TradingView。如果它提示 TradingView 已经在运行
   但没有开启调试端口，请先询问我，只有在我同意后才加上 --restart 再运行一次，因为这会关闭
   TradingView，我可能会丢失未保存的更改。
4. 运行 "npx -y tradingview-desktop-mcp doctor"，并告诉我所有检查是否都通过。如果图表检查失败，
   请提醒我在 TradingView 中把图表标签页切换到前台。
5. 告诉我是否需要重启你或新开一个对话，TradingView 的工具才会出现。
```

完成后，如果它提示你需要，就重启应用或新开一个对话，然后问它：“检查 TradingView 是否已连接。”接着试试[下面的提示词](#try-these-prompts)。

在用 Claude Desktop？它不能运行命令，但 Claude Code、Cursor 以及上面提到的其他应用可以替你配置它：在提示词末尾加上“请为 Claude Desktop 配置（config claude-desktop），而不是为当前这个应用配置。”。ChatGPT 和 OpenAI API 需要一个隧道，这需要你手动设置（参见[远程客户端与隧道](#remote-clients-and-tunnels)）。如果助手卡住了，请自己按照下面的步骤操作。

## <a id="install"></a>安装

你需要：

- TradingView Desktop，已安装并登录。
- Node.js 20.19 或更高版本，它会提供 `npx`。

无需安装其他任何东西：下面的客户端会用 `npx -y tradingview-desktop-mcp` 启动服务器，首次使用时会自动获取该包。请以带调试端口的方式启动 TradingView。`launch` 命令会找到应用并以这种方式启动它：

```sh
npx -y tradingview-desktop-mcp launch
```

TradingView 只允许运行一个实例。如果它已经在运行但没有开启调试端口，`launch` 会停止并说明情况；`launch --restart` 会正常退出它并带上调试端口重新启动，TradingView 可能会先询问你是否保存更改。检查服务器能否连接到应用：

```sh
npx -y tradingview-desktop-mcp doctor
```

当图表标签页处于后台，也就是在“新标签页”页面或其他没有图表的标签页后面时，`doctor` 的图表检查会失败，因此请把图表标签页切换到前台。`npx -y tradingview-desktop-mcp --help` 会列出所有选项，[.env.example](../../.env.example) 则列出了环境变量。

## <a id="connect-your-ai-app"></a>连接你的 AI 应用

`config <client>` 会输出某个客户端的配置片段，并说明它应该放在哪里。下面的每篇教程都包含同样的配置片段、该应用的操作步骤，以及出问题时该怎么办。

| 客户端                                         | 输出配置片段                                           |
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

默认的传输方式是 stdio，此时 stdout 只承载 MCP 消息，日志则输出到 stderr。前七个客户端会自行启动服务器。在 Windows 上，无法直接启动 `npx` 的客户端需要使用 `cmd /c npx` 的形式，`config` 在 Windows 上运行时（或加上 `--platform win32` 时）会输出这种形式。`--profile` 会把一个[工具预设](#tool-profiles)传给服务器。

### <a id="remote-clients-and-tunnels"></a>远程客户端与隧道

ChatGPT 和 OpenAI API 无法在你的电脑上启动程序。它们通过一个公网 HTTPS 地址访问服务器，所以你需要以 HTTP 方式运行服务器，并在它前面放一个隧道。这相当于把一个能控制你已登录的 TradingView 的服务器暴露在互联网上：请使用 `--profile readonly` 和一个强令牌（`TV_MCP_AUTH_TOKEN`），把隧道的公网主机名填进 `--allowed-hosts`（`TV_MCP_ALLOWED_HOSTS`），并使用 `--no-dashboard`，以免仪表板的文件经由隧道对外提供。[ChatGPT](../clients/chatgpt.md) 和 [OpenAI API](../clients/openai-api.md) 的教程会一步步讲解整个过程，[SECURITY.md](../../SECURITY.md#tunnels-and-remote-clients) 则列出了只读令牌仍然能访问到的内容。

## <a id="quick-start-from-source"></a>从源码快速开始

如果要运行检出的源码而不是已发布的包，你需要 Node.js 24 来构建服务器（`nvm use` 会读取 `.nvmrc`），以及 [pnpm](https://pnpm.io)，其版本由 `package.json` 固定。构建好的服务器可以在 Node.js 20.19 或更高版本上运行。

```sh
git clone https://github.com/Mochamad-Rizky/tradingview-desktop-mcp.git
cd tradingview-desktop-mcp
pnpm install && pnpm build
node packages/server/dist/cli.js launch
node packages/server/dist/cli.js doctor
```

`node packages/server/dist/cli.js config <client> --local` 会输出适用于这份检出源码的客户端配置片段，用 `node` 和 `cli.js` 的绝对路径代替 `npx`。对于使用 JSON 配置的客户端，配置条目如下所示：

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

此外还有一种 HTTP 传输方式（`--transport http`）；使用之前请先阅读 [SECURITY.md](../../SECURITY.md)。

## <a id="use-it"></a>使用

按上文所述连接一个 MCP 客户端，在 TradingView 以带调试端口的方式运行时，用平常的话说出你想做的事即可。助手会自己挑选并调用工具，所以你不需要知道它们的名称。[工具参考](../tools.md)列出了每个工具的输入参数及其所属的预设。

### <a id="try-these-prompts"></a>试试这些提示词

下面每条提示词都对应 [docs/examples.md](../examples.md) 中的一个示例，那里展示了助手发出的工具调用及其结果：超过三项的列表做了截断，省略了每次调用的耗时（`durationMs`），截图则以注释注明而不直接展示。下面的摘录是这些结果中的若干行，`…` 表示此处省略了结果中其他部分的行。这些数值都是合成的：它们来自一个模拟的 TradingView 应用和一张虚构的 NASDAQ:AAPL 图表，因此没有任何内容是行情数据，也没有任何内容来自账户；结果的结构与服务器实际返回的一致，不过回测示例背后的策略测试器报告尚未从真实应用中读取过。

**“我的图表上显示的是什么？告诉我商品代码、时间周期，以及上面加载了哪些指标。”** 助手用 `chart_get_state` 读取图表（[详情](../examples.md#1-read-the-chart)）：

```json
"symbol": "NASDAQ:AAPL",
"resolution": "1D",
"chartTypeName": "candles",
```

**“给我看最近 3 根日 K 线。”** 它用 `data_get_ohlcv` 读取 K 线（[详情](../examples.md#3-read-the-last-candles)）：

```json
"timeIso": "2024-10-27T00:00:00Z",
"open": 103.58,
"close": 103.42,
```

**“在我的图表上添加 MACD。”** 如果图表上的指标数量已经达到方案允许的上限，`indicator_add` 不会添加任何指标并会报告该限制，而要移除你的某个指标来腾出位置，则需要你的确认（[详情](../examples.md#5-add-an-indicator-to-a-full-chart)）：

```json
"code": "PLAN_LIMIT",
"message": "The chart holds as many indicators as the plan allows (2)",
```

**“写一个 Pine Script 指标，绘制收盘价的 9 周期和 21 周期移动平均线，并检查它能否编译通过。”** 它用 `pine_new` 把脚本放进 Pine 编辑器，再用 `pine_compile` 编译（[详情](../examples.md#6-write-and-compile-a-pine-script)）：

```json
"success": true,
"errors": [],
"warnings": [],
```

**“我 Pine 编辑器里的脚本编译不通过，你能修好它吗？”** `pine_smart_compile` 会编译脚本，针对它能识别的错误（例如 v6 脚本中使用了 Pine v4 的名称）应用基于规则的修复，然后再次编译，整个过程不会改动编辑器中的内容（[详情](../examples.md#7-fix-a-pine-script-with-smart-compile)）：

```json
"message": "Could not find function or function reference 'study'",
…
"applied": ["Replace study( with indicator(", "Replace rsi( with ta.rsi("]
…
"writtenBack": false
```

**“我图表上的策略回测表现如何？”** 它用 `strategy_get_results` 和 `strategy_get_trades` 读取策略测试器（[详情](../examples.md#8-read-backtest-results)）：

```json
"netProfit": 155,
"totalTrades": 3,
"percentProfitable": 66.67,
"profitFactor": 4.1,
```

**“在我的图表上 102.80 处画一条支撑线。”** 它用 `drawing_create` 画一条水平线，`drawing_list` 会把它和你自己的绘图一起列出，并标记为由本会话绘制（[详情](../examples.md#9-draw-a-support-line)）：

```json
"id": "DRW001",
"shape": "horizontal_line",
"text": "Support",
"createdByServer": true
```

**“苹果股价穿越 110 时提醒我。”** `alert_create` 会在你的 TradingView 账户中设置一个价格警报（[详情](../examples.md#10-create-a-price-alert)）。如果方案中的警报数量已经达到上限，它不会创建任何警报并会报告该限制，`alert_list` 则会列出占满额度的那些警报（[详情](../examples.md#11-create-an-alert-when-the-plan-is-full)）：

```json
"symbol": "NASDAQ:AAPL",
"condition": "crossing",
"price": 110,
"expirationIso": "2024-11-26T00:00:00Z"
```

**“把这些商品加到我的自选表：NYSE:IBM、FX:EURUSD、NASDAQ:MSFT 和 NASDAQ:MSTF。”** `watchlist_add_bulk` 会用 TradingView 的商品搜索逐一检查每个代码，添加新的商品，并说明跳过其他商品的原因（[详情](../examples.md#12-add-symbols-to-a-watchlist)）：

```json
"added": ["NYSE:IBM", "FX:EURUSD"],
…
{ "symbol": "NASDAQ:MSFT", "reason": "already_listed" },
{ "symbol": "NASDAQ:MSTF", "reason": "unknown" }
```

**“让我在图表上从 2024-06-03 开始用 K 线回放练习一下：向前步进五根 K 线，告诉我现在到了哪里，然后结束回放。”** 它用 `replay_start` 开始 K 线回放，用 `replay_step` 步进，用 `replay_status` 读取回放当前所在的位置，再用 `replay_stop` 退出回放。整个过程不会发生任何交易：没有任何工具会下单（[详情](../examples.md#13-practice-with-bar-replay)）：

```json
"dateIso": "2024-06-07T00:00:00Z",
"stepped": 5,
…
"position": null,
"realizedPL": null
```

**“给我的图表截个图。”** `screenshot_capture` 会把截图连同尺寸一起以图像形式交给助手，不会向磁盘写入任何内容（[详情](../examples.md#14-take-a-screenshot)）：

```json
"data": { "target": "chart", "format": "jpeg", "width": 1180, "height": 640, "bytes": 3100 },
"meta": { "via": "cdp", "warnings": [] }
```

服务器还自带五个提示词，支持 MCP 提示词的客户端会把它们列出来供你选择：`analyze_current_chart`、`multi_timeframe_review`、`write_and_backtest_strategy`、`debug_pine_script` 和 `replay_practice_session`。每个提示词都会告诉助手要调用哪些工具、按什么顺序调用，以及最后要汇报什么。`replay_practice_session` 会在 K 线回放上进行一次练习：助手逐根 K 线地推进历史行情，在每一步询问你是做多、做空还是观望，按照从图表上读取的价格为这些假设的交易记账，并计算它们的盈亏。它会先检查你是否有正在进行的回放，如果有，会在做任何改动之前先问你要如何处理；结束时它只会停止自己启动的回放，绝不会停止你的回放。

### <a id="safety"></a>安全

会更改你的图表、脚本或账户的工具，对原本就属于你的内容都很谨慎。替换 Pine 编辑器中未保存的文本（本服务器会话自己在那里做的未保存编辑除外）、为不是本会话创建的脚本保存新版本，以及移除图表上原本就有的指标，都需要 `confirm: true`，而助手只应在你同意后才传入该参数。以下操作同样需要确认：移除不是本会话创建、添加或打开的绘图、警报、自选表商品或标签页，移除图表上的全部绘图，从有未保存更改的布局切换出去，以及切换到一个图表数量少于当前标签页所显示数量的多图表布局（因为下次保存时会丢掉多出来的图表）。方案限制（例如图表上的指标数量、已保存脚本的数量、警报数量或布局中的图表数量）会在添加任何内容之前进行检查，并以附带限制值的 `PLAN_LIMIT` 错误报告；如果在你的 TradingView 版本上无法读取该限制，工具不会执行任何操作并会说明原因。服务器不会绕过任何限制。这些工具会预先检查哪些操作会让 TradingView 弹出升级对话框或它自己的其他对话框，并拒绝执行这些操作，但仍有少数提示是这些检查无法预见的：在图表数量上限较低的方案下切换到已保存的多图表布局、切换到被 TradingView 服务器以超出限制为由拒绝的布局，或者切换到 TradingView 自己维护的列表标记为超出限制而 `layout_list` 并未标记的布局时，`layout_switch` 可能会遇到升级提示；`layout_new` 可能会在通过检查之后遇到 TradingView 拒绝新建布局的消息；对于需要比 TradingView 的等待时间更久才能确定其布局是否有未保存更改的页面，或报告正在录制的页面，`tab_close` 可能会遇到“关闭标签页？”对话框。底层的 `ui_*` 工具会按你的要求点击和输入，因此它们按设计就可能打开 TradingView 的对话框。服务器不会删除或重命名任何脚本。

没有任何工具会下单：K 线回放仅用于练习，助手会把练习交易记录在对话中。截图以图像形式发送给客户端，服务器不会把截图写入磁盘。`ui_evaluate` 用于在图表页面中运行 JavaScript，默认处于关闭状态，除非你用 `--allow-eval`（`TV_MCP_ALLOW_EVAL=true`）启动服务器。

### <a id="tool-profiles"></a>工具预设

默认情况下，服务器提供全部 83 个工具（`--profile full`）。有些客户端只接受有限数量的工具（Cursor 在超过 40 个时会发出警告）。对于这类客户端，`--profile core` 提供精简后的 40 个核心工具，`--profile readonly` 则只提供 37 个读取类工具。`--tools` 接受诸如 `chart_*,data_*` 之类的名称模式，用来进一步缩小预设的范围：工具必须既在预设之中，又匹配某个模式，因此 `--profile core --tools 'pine_*'` 仍然不会包含 `pine_open` 和 `pine_save`，因为它们不是核心工具；使用默认预设时，单靠 `--tools` 就能选定工具。有些描述和提示中提到了 `core` 不包含的工具，例如 `pine_open` 和 `pine_save`，在 `core` 预设下助手无法调用它们。资源跟随工具：每个资源只会和与它共享数据的工具一同提供，例如 `tradingview://pine/source` 与 `pine_get_source` 一同提供，所以 `--tools 'chart_*'` 会提供图表状态，而不会提供任何与 Pine 编辑器相关的内容。

[工具参考](../tools.md)列出了每个工具的输入参数及其所属的预设。

## <a id="troubleshooting"></a>故障排除

[docs/troubleshooting.md](../troubleshooting.md) 解释了每个错误码，以及在找不到 TradingView、调试端口被占用、客户端不显示工具或隧道拒绝请求时该怎么办。遇到问题时，首先要运行的是 `npx -y tradingview-desktop-mcp doctor`。

## <a id="dashboard"></a>仪表板

服务器自带一个 Web 仪表板，可以用来观察你的助手在做什么，也可以手动试用某个工具。它不需要额外安装：已发布的包中就带有它，而 `pnpm build` 会把它构建进检出源码的服务器中。

![状态页：TradingView 可访问、已找到图表且应用已就绪，服务器的相关信息，以及方案限制](../images/dashboard-status.png)

### <a id="open-it"></a>打开仪表板

- **HTTP 传输方式：** 带上令牌启动服务器，然后打开 `http://127.0.0.1:8787/`。在这种模式下仪表板默认开启；`--no-dashboard`（`TV_MCP_DASHBOARD=false`）可以将其关闭。

  ```sh
  TV_MCP_AUTH_TOKEN="$(openssl rand -hex 32)" npx -y tradingview-desktop-mcp --transport http
  ```

  如果使用的是检出的源码，请改为运行 `node packages/server/dist/cli.js --transport http`。

- **与 stdio 并用：** 通过 stdio 启动服务器的 MCP 客户端同样可以使用仪表板。在它的配置中加入 `--dashboard`（`TV_MCP_DASHBOARD=true`）和 `TV_MCP_AUTH_TOKEN`。仪表板会监听自己的地址，除非你设置了 `--host` 和 `--port`，否则就是 `127.0.0.1:8787`，并且不提供 `/mcp`。如果没有令牌，或者端口已被占用，仪表板会保持关闭，服务器会记录一条警告，但 MCP 服务器会继续运行。客户端发出的调用会显示在实时日志中。

服务器启动时会在 stderr 上打印仪表板的地址。它从不打印令牌。

### <a id="the-token"></a>令牌

页面在显示任何内容之前，会先要求输入令牌（`TV_MCP_AUTH_TOKEN`）。你可以把令牌粘贴进去，或者打开一次 `http://127.0.0.1:8787/#token=<token>`：页面会从 URL 片段中读取令牌并将其从地址栏中移除，而片段永远不会发送到服务器。页面把令牌保存在 `sessionStorage` 中，因此关闭标签页后令牌就会消失；它只以 `Authorization: Bearer <token>` 的形式发送令牌，从不放在 URL 中。当服务器使用另一个令牌重启后，页面会再次要求输入。参见 [SECURITY.md](../../SECURITY.md#the-dashboard)。

### <a id="what-it-shows"></a>显示内容

![实时日志：工具调用的表格，最新的排在最前，列出时间、工具、来源、状态和耗时，上方是搜索框和筛选器](../images/dashboard-log.png)

- **Status**（状态）显示 TradingView 是否可访问（不可访问时还会告诉你如何启动它）、服务器的运行方式、方案限制以及最近的调用。
- **Log**（日志）实时推送服务器运行的每一次工具调用，无论它是由 MCP 客户端还是仪表板发起的，并支持按工具名称筛选、暂停、清空以及查看每次调用的详情。连接断开后，它会显示“Reconnecting…”，并从中断的地方继续。仪表板每个打开的标签页都会与服务器保持一条事件流，而浏览器对同一主机大约只允许六个连接，所以当打开了很多仪表板标签页时，新的标签页可能要等待空闲的连接：请关闭不用的标签页。
- **Tools**（工具）列出服务器提供的工具及其输入参数，并可以手动运行其中一个。结果按返回时的原样显示，较长的 JSON 会折叠在“Show all”后面，图片则直接以图片显示。

![工具页：左侧是带搜索框和筛选器的工具列表，右侧是 chart_get_state 及其描述、相关信息和输入字段](../images/dashboard-tools.png)

从仪表板发起的运行是真实的工具调用。它与 MCP 调用经过同一个注册表，因此同样适用相同的 schema、预设、`confirm` 规则和方案限制检查，并且会出现在日志中。在运行任何非只读的工具之前，仪表板都会请你确认。

### <a id="the-api"></a>API

页面通过一个小型 API 与服务器通信，你也可以用 `curl` 加上令牌来调用它。每个路由都需要 `Authorization: Bearer <token>`，服务器会像对待 `/mcp` 一样检查 `Host` 和 `Origin`。

| 路由                     | 作用                                                         |
| ------------------------ | ------------------------------------------------------------ |
| `GET /api/info`          | 版本、传输方式、预设、工具数量和启动时间                     |
| `GET /api/health`        | 健康报告：TradingView 是否可访问                             |
| `GET /api/tools`         | 当前提供的工具，以及它们的 schema 和注解                     |
| `POST /api/tools/<name>` | 以 `{"arguments": {...}}` 运行一个工具，来源记为 `dashboard` |
| `GET /api/events`        | 工具调用的服务器发送事件（SSE）；`?limit=` 设置要重放多少条  |

页面本身的文件位于 `/`，不需要令牌，也不包含任何数据。

## <a id="contributing"></a>参与贡献

本地开发环境的搭建、测试层级、提交约定以及发布流程，请参见 [CONTRIBUTING.md](../../CONTRIBUTING.md)；测试指南请参见 [docs/testing.md](../testing.md)。如需报告安全漏洞，请按照 [SECURITY.md](../../SECURITY.md) 中的说明操作。

## <a id="disclaimer"></a>免责声明

本项目与 TradingView, Inc. 没有任何关联，也未获得其认可或赞助。TradingView 是其所有者的商标。本文的任何内容都不构成投资建议。这些工具会改变应用显示的内容，并可能操作到它的控件，因此你需要对自己自动化的操作负责，并遵守 TradingView 的使用条款。

## <a id="license"></a>许可证

基于 [MIT 许可证](../../LICENSE)发布。
