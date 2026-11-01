# tradingview-desktop-mcp

[English](../../README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · **日本語** · [한국어](README.ko.md) · [Türkçe](README.tr.md) · [Русский](README.ru.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Українська](README.uk.md) · [Polski](README.pl.md) · [Português (Brasil)](README.pt-BR.md) · [العربية](README.ar.md) · [فارسی](README.fa.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Ελληνικά](README.el.md) · [മലയാളം](README.ml.md) · [Roman Urdu](README.ur-Latn.md) · [Română](README.ro.md)

[![npm](https://img.shields.io/npm/v/tradingview-desktop-mcp)](https://www.npmjs.com/package/tradingview-desktop-mcp)
[![CI](https://github.com/Mochamad-Rizky/tradingview-desktop-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Mochamad-Rizky/tradingview-desktop-mcp/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/Mochamad-Rizky/tradingview-desktop-mcp/graph/badge.svg)](https://codecov.io/gh/Mochamad-Rizky/tradingview-desktop-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../../LICENSE)

> これは[英語版 README](../../README.md) の翻訳です。両者の内容が異なる場合は、英語版を正とします。

<p align="center">
  <a href="../media/promo.mp4"><img src="../media/teaser.gif" width="49%" alt="概要動画：アシスタントがチャートを読み取り、サポートラインを引き、Pine Script を書いて価格アラートを設定する様子"></a>
  <a href="../media/tutorial.mp4"><img src="../media/tutorial-poster.jpg" width="49%" alt="セットアップチュートリアル：5 つのステップでセットアップ"></a>
</p>

<p align="center">
  <a href="../media/promo.mp4"><b>▶ 概要動画を見る</b></a> (0:48) &nbsp;·&nbsp;
  <a href="../media/tutorial.mp4"><b>▶ セットアップチュートリアルを見る</b></a> (1:53)<br>
  <sub>どちらの動画も架空のチャートを使用しており、実際の市場データではありません。</sub>
</p>

AI アシスタントが、お使いのマシン上の TradingView Desktop アプリを読み取り、操作できるようにする [MCP](https://modelcontextprotocol.io) サーバーです。すでにログインしているアプリを Chrome DevTools Protocol 経由で操作します。その際に使うのは、アプリを `--remote-debugging-port` 付きで起動したときに開かれるデバッグポートです。自動化するのはローカルのアプリだけです。代わりにログインすることも、プランの制限を回避することも、TradingView のサーバーを呼び出すこともありません。

> **ステータス：1.0 未満のプレリリース版。** 1.0 までの間に、ツール名やオプションが変わる可能性があります。以下の手順で npm からパッケージをインストールするか、[ソースから](#quick-start-from-source)サーバーを実行してください。macOS で動作を確認しています。Windows と Linux はベストエフォートでのサポートです。

サーバーが提供するツールは次のとおりです。アプリ系ツール（起動、ヘルスチェック、検出、インターフェースの状態、プランの制限、再接続）、チャート系ツール（状態、シンボル、時間足、チャートタイプ、表示範囲、スクロール）、マーケットデータ系ツール（バー、クォート、シンボル情報と検索）、インジケーター系ツール（一覧、検索、追加、削除、入力値、表示・非表示、値）、Pine Script 系ツール（エディターと保存済みスクリプト、コンパイル、ルールベースの修正付きスマートコンパイル、オフライン解析、コンソール、およびスクリプトが描画するライン、ラベル、ボックス、テーブル）、ストラテジーテスター系ツール（結果、トレード、資産曲線）、描画・アラート・ウォッチリスト系ツール、レイアウト・マルチチャート・タブ系ツール、バーリプレイ、スクリーンショット、低レベルのインターフェース系ツール（クリック、ホバー、文字入力、キー操作、スクロール、検索、パネル、全画面表示、そして許可した場合にはチャートページ内での JavaScript の実行）、さらに複数のツールを 1 回の呼び出しで実行する `batch_run` です。また、リソース（アプリのヘルス状態、チャートの状態とバー、Pine のソースと直近のコンパイル結果、ストラテジーレポート、アクティブなウォッチリスト）も提供しており、それぞれデータを共有するツールと一緒に提供されます。加えて、よくある作業のためのプロンプトが 5 つあります。Web ダッシュボードでは、呼び出しをリアルタイムで確認したり、ツールを手動で実行したりできます（[ダッシュボード](#dashboard)を参照）。

目次：[AI アプリに頼んでインストールする](#install-by-asking-your-ai-app)、[インストール](#install)、[AI アプリを接続する](#connect-your-ai-app)、[リモートクライアントとトンネル](#remote-clients-and-tunnels)、[ソースからのクイックスタート](#quick-start-from-source)、[使い方](#use-it)、[トラブルシューティング](#troubleshooting)、[ダッシュボード](#dashboard)、[コントリビュート](#contributing)。

## <a id="install-by-asking-your-ai-app"></a>AI アプリに頼んでインストールする

自分でコマンドを入力する必要はありません。お使いの AI アプリがコンピューター上でコマンドを実行できるなら（Claude Code、Cursor、VS Code、Windsurf、Gemini CLI、Codex CLI はいずれも可能です）、セットアップを代わりに行ってくれます。まず、次の準備をしてください。

1. [TradingView Desktop](https://www.tradingview.com/desktop/) をインストールしてログインします。
2. まだ入っていなければ [Node.js](https://nodejs.org)（LTS 版）をインストールします。

次に、以下のプロンプトをコピーして AI アプリに貼り付け、送信してください。

```text
TradingView MCP サーバーをインストールしてください。npm パッケージ tradingview-desktop-mcp
(https://github.com/Mochamad-Rizky/tradingview-desktop-mcp) です。次の手順に従い、各ステップを
わかりやすい言葉で説明してください。

1. Node.js 20.19 以降がインストールされているか確認してください。入っていなければ、そこで止めて
   インストール方法を教えてください。
2. "npx -y tradingview-desktop-mcp config <client>" を実行してください。<client> には、あなたが
   動作しているアプリ（claude-code、cursor、vscode、windsurf、gemini-cli、codex-cli のいずれか）を
   指定します。出力された指示に従って、サーバーを私の設定に追加してください。設定にすでにある
   ほかのサーバーはそのまま残してください。
3. "npx -y tradingview-desktop-mcp launch" で TradingView を起動してください。TradingView が
   デバッグポートなしですでに起動していると表示された場合は、まず私に確認し、私が同意したときだけ
   --restart を付けて再実行してください。TradingView が終了するため、保存していない変更が
   失われる可能性があるからです。
4. "npx -y tradingview-desktop-mcp doctor" を実行し、すべてのチェックに合格したかを教えてください。
   チャートのチェックに失敗した場合は、TradingView でチャートのタブを前面に出すよう伝えてください。
5. TradingView のツールが表示されるまでに、あなたを再起動するか新しいチャットを開く必要があるかを
   教えてください。
```

完了したら、指示があればアプリを再起動するか新しいチャットを開き、「TradingView に接続されているか確認して」と頼んでみてください。そのあと、[以下のプロンプト](#try-these-prompts)を試してみましょう。

Claude Desktop をお使いですか？ Claude Desktop はコマンドを実行できませんが、Claude Code や Cursor など上記のアプリが代わりにセットアップできます。プロンプトの末尾に「このアプリではなく、Claude Desktop 用にセットアップしてください（config claude-desktop）。」と追加してください。ChatGPT と OpenAI API にはトンネルが必要で、これは手動で設定します（[リモートクライアントとトンネル](#remote-clients-and-tunnels)を参照）。アシスタントが行き詰まった場合は、以下の手順に自分で従ってください。

## <a id="install"></a>インストール

必要なもの：

- インストール済みでログインした状態の TradingView Desktop。
- Node.js 20.19 以降（`npx` が含まれます）。

ほかに何もインストールする必要はありません。以下のクライアントは `npx -y tradingview-desktop-mcp` でサーバーを起動し、初回の使用時にパッケージが取得されます。TradingView はデバッグポート付きで起動してください。`launch` コマンドがアプリを見つけて、その方法で起動します。

```sh
npx -y tradingview-desktop-mcp launch
```

TradingView は 1 つのインスタンスしか起動できません。デバッグポートなしですでに起動している場合、`launch` は処理を止めてその旨を伝えます。`launch --restart` は TradingView を正常に終了させてから、ポート付きで起動し直します。このとき TradingView から先に変更を保存するよう求められることがあります。サーバーがアプリに接続できるか確認しましょう。

```sh
npx -y tradingview-desktop-mcp doctor
```

チャートのタブがバックグラウンドにある間、つまり「新しいタブ」ページやチャートのない別のタブの裏にある間は、`doctor` のチャートのチェックが失敗します。チャートのタブを前面に出してください。`npx -y tradingview-desktop-mcp --help` でオプションの一覧が、[.env.example](../../.env.example) で環境変数の一覧が確認できます。

## <a id="connect-your-ai-app"></a>AI アプリを接続する

`config <client>` は、クライアントの設定スニペットを出力し、それをどこに置くかを示します。以下の各チュートリアルには、同じスニペットと、そのアプリでの手順、そしてうまくいかないときの対処法が載っています。

| クライアント                                   | スニペットを出力する                                   |
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

デフォルトのトランスポートは stdio で、stdout には MCP メッセージだけが流れ、ログは stderr に出力されます。最初の 7 つのクライアントは、サーバーを自分で起動します。Windows で `npx` を直接起動できないクライアントには `cmd /c npx` の形式が必要です。`config` を Windows 上で実行すると（または `--platform win32` を付けると）、この形式が出力されます。`--profile` は[ツールプロファイル](#tool-profiles)をサーバーに渡します。

### <a id="remote-clients-and-tunnels"></a>リモートクライアントとトンネル

ChatGPT と OpenAI API は、お使いのコンピューター上でプログラムを起動できません。これらは公開された HTTPS アドレスでサーバーにアクセスするため、サーバーを HTTP で実行し、その前段にトンネルを置く必要があります。これは、ログイン済みの TradingView を操作できるサーバーをインターネットに公開することを意味します。`--profile readonly`、強力なトークン（`TV_MCP_AUTH_TOKEN`）、`--allowed-hosts`（`TV_MCP_ALLOWED_HOSTS`）にトンネルの公開ホストを指定すること、そして `--no-dashboard` を使って、ダッシュボードのファイルがトンネル経由で配信されないようにしてください。手順は [ChatGPT](../clients/chatgpt.md) と [OpenAI API](../clients/openai-api.md) のチュートリアルで順を追って説明しています。読み取り専用のトークンでもアクセスできる範囲については [SECURITY.md](../../SECURITY.md#tunnels-and-remote-clients) にまとめています。

## <a id="quick-start-from-source"></a>ソースからのクイックスタート

公開パッケージではなくチェックアウトしたソースを実行するには、サーバーのビルドに Node.js 24（`nvm use` が `.nvmrc` を読み込みます）と、`package.json` でバージョンが固定されている [pnpm](https://pnpm.io) が必要です。ビルドしたサーバーは Node.js 20.19 以降で動作します。

```sh
git clone https://github.com/Mochamad-Rizky/tradingview-desktop-mcp.git
cd tradingview-desktop-mcp
pnpm install && pnpm build
node packages/server/dist/cli.js launch
node packages/server/dist/cli.js doctor
```

`node packages/server/dist/cli.js config <client> --local` は、このチェックアウト用のクライアントのスニペットを出力します。`npx` の代わりに `node` と `cli.js` の絶対パスが使われます。JSON で設定するクライアントの場合、エントリは次のようになります。

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

HTTP トランスポート（`--transport http`）もあります。使用する前に [SECURITY.md](../../SECURITY.md) を読んでください。

## <a id="use-it"></a>使い方

上記の説明に従って MCP クライアントを接続し、TradingView をデバッグポート付きで起動した状態で、やりたいことを普段の言葉で頼んでください。アシスタントがツールを選んで呼び出すので、ツール名を知っておく必要はありません。[ツールリファレンス](../tools.md)には、すべてのツールについて入力と所属するプロファイルが記載されています。

### <a id="try-these-prompts"></a>このプロンプトを試してみよう

以下の各プロンプトは [docs/examples.md](../examples.md) にある例のひとつです。そこでは、アシスタントが行うツール呼び出しとその結果を示しています。ただし、4 項目以上のリストは省略し、各呼び出しの所要時間（`durationMs`）は除き、スクリーンショットは表示する代わりに注記で示しています。以下の抜粋はそれらの結果の一部の行で、`…` は結果のほかの部分の行を省略した箇所を表します。値はすべて合成したものです。架空の NASDAQ:AAPL チャートを表示した偽の TradingView アプリから得たものなので、市場データは一切含まれず、アカウントから取得したものもありません。結果の形はサーバーが返すとおりですが、バックテストの例の元になっているストラテジーテスターのレポートは、まだ実際のアプリから読み取ったことがありません。

**「いまチャートに何が表示されてる？ シンボル、時間足、どのインジケーターが載っているかを教えて。」** アシスタントは `chart_get_state` でチャートを読み取ります（[詳細](../examples.md#1-read-the-chart)）。

```json
"symbol": "NASDAQ:AAPL",
"resolution": "1D",
"chartTypeName": "candles",
```

**「直近 3 本の日足を見せて。」** `data_get_ohlcv` でバーを読み取ります（[詳細](../examples.md#3-read-the-last-candles)）。

```json
"timeIso": "2024-10-27T00:00:00Z",
"open": 103.58,
"close": 103.42,
```

**「チャートに MACD を追加して。」** プランで許可されている上限までインジケーターが載っているチャートでは、`indicator_add` は何も追加せずに上限を報告します。空きを作るためにあなたのインジケーターを削除するには、あなたの確認が必要です（[詳細](../examples.md#5-add-an-indicator-to-a-full-chart)）。

```json
"code": "PLAN_LIMIT",
"message": "The chart holds as many indicators as the plan allows (2)",
```

**「終値の 9 本と 21 本の移動平均線を描く Pine Script のインジケーターを書いて、コンパイルが通るか確認して。」** `pine_new` でスクリプトを Pine エディターに入れ、`pine_compile` でコンパイルします（[詳細](../examples.md#6-write-and-compile-a-pine-script)）。

```json
"success": true,
"errors": [],
"warnings": [],
```

**「Pine エディターのスクリプトがコンパイルできない。直してくれる？」** `pine_smart_compile` はスクリプトをコンパイルし、v6 のスクリプト内の Pine v4 の名前など、既知のエラーにルールベースの修正を適用してから、再度コンパイルします。エディターの内容は変更しません（[詳細](../examples.md#7-fix-a-pine-script-with-smart-compile)）。

```json
"message": "Could not find function or function reference 'study'",
…
"applied": ["Replace study( with indicator(", "Replace rsi( with ta.rsi("]
…
"writtenBack": false
```

**「チャート上のストラテジーのバックテスト結果はどうだった？」** `strategy_get_results` と `strategy_get_trades` でストラテジーテスターを読み取ります（[詳細](../examples.md#8-read-backtest-results)）。

```json
"netProfit": 155,
"totalTrades": 3,
"percentProfitable": 66.67,
"profitFactor": 4.1,
```

**「チャートの 102.80 にサポートラインを引いて。」** `drawing_create` で水平線を描きます。`drawing_list` では、それがあなた自身の描画と並んで、このセッションが描いたものとして表示されます（[詳細](../examples.md#9-draw-a-support-line)）。

```json
"id": "DRW001",
"shape": "horizontal_line",
"text": "Support",
"createdByServer": true
```

**「Apple が 110 をクロスしたら知らせて。」** `alert_create` が、あなたの TradingView アカウントに価格アラートを設定します（[詳細](../examples.md#10-create-a-price-alert)）。プランで許可されている上限までアラートがすでにある場合は、何も作成せずに上限を報告し、`alert_list` でその枠を埋めているアラートを確認できます（[詳細](../examples.md#11-create-an-alert-when-the-plan-is-full)）。

```json
"symbol": "NASDAQ:AAPL",
"condition": "crossing",
"price": 110,
"expirationIso": "2024-11-26T00:00:00Z"
```

**「次のシンボルをウォッチリストに追加して：NYSE:IBM、FX:EURUSD、NASDAQ:MSFT、NASDAQ:MSTF。」** `watchlist_add_bulk` は TradingView のシンボル検索で各シンボルを確認し、新しいものを追加して、ほかのものをスキップした理由を伝えます（[詳細](../examples.md#12-add-symbols-to-a-watchlist)）。

```json
"added": ["NYSE:IBM", "FX:EURUSD"],
…
{ "symbol": "NASDAQ:MSFT", "reason": "already_listed" },
{ "symbol": "NASDAQ:MSTF", "reason": "unknown" }
```

**「2024-06-03 からのバーリプレイでチャートの練習をさせて。5 本進めて、いまどこにいるかを教えてから、リプレイを終了して。」** `replay_start` でバーリプレイを開始し、`replay_step` で進め、`replay_status` でリプレイの現在位置を読み取り、`replay_stop` で終了します。売買は一切行われません。注文を出すツールはありません（[詳細](../examples.md#13-practice-with-bar-replay)）。

```json
"dateIso": "2024-06-07T00:00:00Z",
"stepped": 5,
…
"position": null,
"realizedPL": null
```

**「チャートのスクリーンショットを撮って。」** `screenshot_capture` は画像をそのサイズと一緒にアシスタントへ渡し、ディスクには何も書き込みません（[詳細](../examples.md#14-take-a-screenshot)）。

```json
"data": { "target": "chart", "format": "jpeg", "width": 1180, "height": 640, "bytes": 3100 },
"meta": { "via": "cdp", "warnings": [] }
```

サーバーには独自のプロンプトも 5 つ用意されており、MCP プロンプトに対応したクライアントでは一覧から選べます：`analyze_current_chart`、`multi_timeframe_review`、`write_and_backtest_strategy`、`debug_pine_script`、`replay_practice_session`。それぞれのプロンプトは、どのツールをどの順番で呼び出し、何を報告するかをアシスタントに指示します。`replay_practice_session` はバーリプレイで練習セッションを行います。アシスタントは過去のチャートを 1 本ずつ進め、各ステップでロングするか、ショートするか、ノーポジションのままにするかをあなたに尋ね、チャートから読み取った価格でこれらの仮想トレードを記録し、その損益を計算します。最初にあなたのリプレイが実行中かどうかを確認し、実行中であれば何かを変更する前にどうするかをあなたに尋ねます。最後には自分が開始したリプレイだけを停止し、あなたのリプレイを停止することはありません。

### <a id="safety"></a>安全性

チャートやスクリプト、アカウントを変更するツールは、もともとあなたのものに対して慎重に動作します。Pine エディター内の未保存のテキストを置き換えること（このサーバーセッション自身がそこで行った未保存の編集を除く）、このセッションが作成していないスクリプトの新しいバージョンを保存すること、チャートにもともと載っていたインジケーターを削除することには、いずれも `confirm: true` が必要で、アシスタントはあなたが同意した後にだけこれを渡すべきです。同様に、このセッションが作成・追加・オープンしていない描画、アラート、ウォッチリストのシンボル、タブを削除すること、チャートのすべての描画を削除すること、未保存の変更があるレイアウトから切り替えること、そしてタブに表示されているよりチャート数の少ないマルチチャートレイアウトに変更すること（次に保存したときに残りのチャートが失われます）にも確認が必要です。チャート上のインジケーター数、保存済みスクリプト数、アラート数、レイアウト内のチャート数といったプランの制限は、何かを追加する前にチェックされ、上限値とともに `PLAN_LIMIT` エラーとして報告されます。お使いの TradingView のビルドで上限を読み取れない場合、ツールは何もせず、その旨を伝えます。サーバーが制限を回避することはありません。ツールは、TradingView のアップグレードダイアログやその他の独自ダイアログが開く原因になる操作を事前にチェックし、代わりに実行を拒否します。ただし、これらのチェックでは予測できないプロンプトがいくつか残っています。`layout_switch` は、チャート数の上限が少ないプランで保存済みのマルチチャートレイアウトに切り替えるとき、TradingView のサーバーが上限超過として拒否するレイアウトに切り替えるとき、そして TradingView が内部で保持しているリストでは上限超過とされているのに `layout_list` ではそうなっていないレイアウトに切り替えるときに、アップグレードのプロンプトに遭遇することがあります。`layout_new` は、チェックを通過した後に TradingView が新しいレイアウトを拒否するメッセージに遭遇することがあります。`tab_close` は、レイアウトに未保存の変更があるかどうかの応答に TradingView の待機時間より長くかかるページや、録画中であると報告するページで、「タブを閉じますか？」ダイアログに遭遇することがあります。低レベルの `ui_*` ツールは指示どおりにクリックや入力を行うため、仕様上 TradingView のダイアログを開くことがあります。サーバーがスクリプトを削除したり名前を変更したりすることはありません。

注文を出すツールはありません。バーリプレイは練習用で、練習トレードはアシスタントが会話の中で記録します。スクリーンショットは画像としてクライアントに送られ、サーバーがディスクに書き込むことはありません。チャートページ内で JavaScript を実行する `ui_evaluate` は、`--allow-eval`（`TV_MCP_ALLOW_EVAL=true`）付きでサーバーを起動しない限り無効です。

### <a id="tool-profiles"></a>ツールプロファイル

デフォルトでは、サーバーは 83 個すべてのツールを提供します（`--profile full`）。クライアントによっては、受け付けるツールの数に制限があります（Cursor は 40 個を超えると警告を出します）。そうしたクライアント向けに、`--profile core` は厳選した 40 個の基本ツールに絞ったセットを、`--profile readonly` は読み取りを行う 37 個のツールだけを提供します。`--tools` は `chart_*,data_*` のような名前のパターンを受け取り、プロファイルをさらに絞り込みます。ツールはプロファイルに含まれ、かつパターンに一致する必要があるため、`--profile core --tools 'pine_*'` でも、コアツールではない `pine_open` と `pine_save` は含まれません。デフォルトのプロファイルでは、`--tools` だけでツールを選べます。説明文やヒントの中には、`pine_open` や `pine_save` のように `core` に含まれないツールに触れているものがありますが、`core` ではアシスタントはそれらを呼び出せません。リソースはツールに従います。各リソースは、データを共有するツールと一緒にのみ提供されます。たとえば `tradingview://pine/source` は `pine_get_source` と一緒に提供されるため、`--tools 'chart_*'` ではチャートの状態は提供されますが、Pine エディターに関するものは何も提供されません。

[ツールリファレンス](../tools.md)には、すべてのツールについて入力と所属するプロファイルが記載されています。

## <a id="troubleshooting"></a>トラブルシューティング

[docs/troubleshooting.md](../troubleshooting.md) では、各エラーコードの意味と、TradingView が見つからない、デバッグポートが使用中、クライアントにツールが表示されない、トンネルがリクエストを拒否する、といった場合の対処法を説明しています。まず最初に実行すべきなのは `npx -y tradingview-desktop-mcp doctor` です。

## <a id="dashboard"></a>ダッシュボード

サーバーには Web ダッシュボードが付属しており、アシスタントが何をしているかを確認したり、ツールを手動で試したりできます。追加のインストールは不要です。公開パッケージに同梱されており、チェックアウトの場合は `pnpm build` でサーバーに組み込まれます。

![ステータスページ：TradingView に接続でき、チャートが見つかりアプリの準備ができている状態、サーバーの情報、プランの制限](../images/dashboard-status.png)

### <a id="open-it"></a>開き方

- **HTTP トランスポート：** トークンを指定してサーバーを起動し、`http://127.0.0.1:8787/` を開きます。このモードではダッシュボードはデフォルトで有効です。`--no-dashboard`（`TV_MCP_DASHBOARD=false`）で無効にできます。

  ```sh
  TV_MCP_AUTH_TOKEN="$(openssl rand -hex 32)" npx -y tradingview-desktop-mcp --transport http
  ```

  チェックアウトから実行する場合は、代わりに `node packages/server/dist/cli.js --transport http` を実行します。

- **stdio と併用：** stdio でサーバーを起動する MCP クライアントでも、ダッシュボードを使えます。設定に `--dashboard`（`TV_MCP_DASHBOARD=true`）と `TV_MCP_AUTH_TOKEN` を追加してください。ダッシュボードは独自のアドレスで待ち受けます。`--host` と `--port` を設定しない限り `127.0.0.1:8787` で、`/mcp` は提供しません。トークンがない場合やポートが使用中の場合、ダッシュボードは無効のままでサーバーは警告をログに記録しますが、MCP サーバーはそのまま動き続けます。クライアントによる呼び出しはライブログに表示されます。

サーバーは起動時にダッシュボードのアドレスを stderr に出力します。トークンが出力されることはありません。

### <a id="the-token"></a>トークン

ページは何かを表示する前にトークン（`TV_MCP_AUTH_TOKEN`）の入力を求めます。トークンを貼り付けるか、一度 `http://127.0.0.1:8787/#token=<token>` を開いてください。ページはフラグメントからトークンを読み取ってアドレスから取り除きます。フラグメントがサーバーに送信されることはありません。ページはトークンを `sessionStorage` に保持するため、タブを閉じるとトークンは消えます。また、トークンは `Authorization: Bearer <token>` としてのみ送信し、URL に含めることはありません。サーバーが別のトークンで再起動すると、ページは再度トークンを求めます。[SECURITY.md](../../SECURITY.md#the-dashboard) を参照してください。

### <a id="what-it-shows"></a>表示される内容

![ライブログ：ツール呼び出しの表（新しい順）。時刻、ツール、発信元、ステータス、所要時間が表示され、その上に検索とフィルターがある](../images/dashboard-log.png)

- **Status**（ステータス）は、TradingView に接続できるか（できない場合はその起動方法）、サーバーの動作状況、プランの制限、最近の呼び出しを表示します。
- **Log**（ログ）は、MCP クライアントとダッシュボードのどちらからの呼び出しかを問わず、サーバーが実行したすべてのツール呼び出しをストリーミング表示します。ツール名によるフィルター、一時停止、クリア、各呼び出しの詳細表示ができます。接続が切れると「Reconnecting…」と表示され、中断したところから再開します。ダッシュボードの各タブはサーバーとのイベントストリームを 1 本ずつ保持しますが、ブラウザーが 1 つのホストに許可する接続はおよそ 6 本までです。そのため、ダッシュボードのタブを多く開いていると、新しいタブが空き接続を待つことがあります。使っていないタブは閉じてください。
- **Tools**（ツール）は、サーバーが提供するツールを入力とともに一覧表示し、手動で実行できます。結果は返ってきたとおりに表示され、長い JSON は「Show all」の下に折りたたまれ、画像は画像として表示されます。

![ツールページ：左側に検索とフィルター付きのツール一覧、右側に chart_get_state の説明、情報、入力フィールド](../images/dashboard-tools.png)

ダッシュボードからの実行は、実際のツール呼び出しです。MCP の呼び出しと同じレジストリを経由するため、同じスキーマ、プロファイル、`confirm` のルール、プランの制限チェックが適用され、ログにも表示されます。読み取り専用ではないツールを実行する前には、ダッシュボードが確認を求めます。

### <a id="the-api"></a>API

ページは小さな API を通じてサーバーとやり取りしています。この API は `curl` とトークンを使って自分で呼び出すこともできます。すべてのルートで `Authorization: Bearer <token>` が必要で、サーバーは `/mcp` の場合と同様に `Host` と `Origin` をチェックします。

| ルート                   | 内容                                                                |
| ------------------------ | ------------------------------------------------------------------- |
| `GET /api/info`          | バージョン、トランスポート、プロファイル、ツール数、起動時刻        |
| `GET /api/health`        | ヘルスレポート：TradingView に接続できるかどうか                    |
| `GET /api/tools`         | 提供中のツールと、そのスキーマおよびアノテーション                  |
| `POST /api/tools/<name>` | `{"arguments": {...}}` でツールを実行（発信元は `dashboard`）       |
| `GET /api/events`        | ツール呼び出しの Server-Sent Events。`?limit=` で再送する件数を指定 |

`/` にあるページ自体のファイルはトークン不要で、データは含まれていません。

## <a id="contributing"></a>コントリビュート

ローカル環境のセットアップ、テストのレベル、コミットの規約、リリースの手順については [CONTRIBUTING.md](../../CONTRIBUTING.md) を、テストのガイドについては [docs/testing.md](../testing.md) を参照してください。脆弱性を報告する場合は [SECURITY.md](../../SECURITY.md) の手順に従ってください。

## <a id="disclaimer"></a>免責事項

このプロジェクトは TradingView, Inc. とは提携しておらず、同社による承認や後援も受けていません。TradingView はその所有者の商標です。ここに記載されている内容は、いずれも投資助言ではありません。これらのツールはアプリの表示内容を変更し、その操作部にアクセスすることがあるため、何を自動化するか、そして TradingView の利用規約を守ることについては、あなた自身の責任となります。

## <a id="license"></a>ライセンス

[MIT ライセンス](../../LICENSE)のもとで公開しています。
