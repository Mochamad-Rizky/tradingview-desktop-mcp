# tradingview-desktop-mcp

[English](../../README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Türkçe](README.tr.md) · [Русский](README.ru.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Українська](README.uk.md) · [Polski](README.pl.md) · [Português (Brasil)](README.pt-BR.md) · [العربية](README.ar.md) · [فارسی](README.fa.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Ελληνικά](README.el.md) · [മലയാളം](README.ml.md) · **Roman Urdu** · [Română](README.ro.md)

[![npm](https://img.shields.io/npm/v/tradingview-desktop-mcp)](https://www.npmjs.com/package/tradingview-desktop-mcp)
[![CI](https://github.com/Mochamad-Rizky/tradingview-desktop-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Mochamad-Rizky/tradingview-desktop-mcp/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/Mochamad-Rizky/tradingview-desktop-mcp/graph/badge.svg)](https://codecov.io/gh/Mochamad-Rizky/tradingview-desktop-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../../LICENSE)

> Yeh [English README](../../README.md) ka tarjuma hai. Agar dono mein farq ho to English version hi reference hai.

<p align="center">
  <a href="../media/promo.mp4"><img src="../media/teaser.gif" width="49%" alt="Overview video: ek assistant chart parhta hai, support line draw karta hai, Pine Script likhta hai aur price alert set karta hai"></a>
  <a href="../media/tutorial.mp4"><img src="../media/tutorial-poster.jpg" width="49%" alt="Setup tutorial: paanch steps mein set up karein"></a>
</p>

<p align="center">
  <a href="../media/promo.mp4"><b>▶ Overview dekhein</b></a> (0:48) &nbsp;·&nbsp;
  <a href="../media/tutorial.mp4"><b>▶ Setup tutorial dekhein</b></a> (1:53)<br>
  <sub>Dono videos mein ek farzi chart use hua hai, asal market data nahi.</sub>
</p>

Yeh ek [MCP](https://modelcontextprotocol.io) server hai jo AI assistants ko aap ki apni machine par
TradingView Desktop app parhne aur control karne deta hai. Yeh us app ko chalata hai jis mein aap pehle se
logged in hain, Chrome DevTools Protocol ke zariye, us debug port se jo app `--remote-debugging-port` ke
saath start hone par kholta hai. Yeh sirf local app ko automate karta hai: yeh aap ki jagah login nahi
karta, plan limits ko bypass nahi karta, aur TradingView ke servers ko call nahi karta.

> **Status: pre-1.0.** 1.0 se pehle tool names aur options badal sakte hain. Package ko npm se install
> karein, jaise neeche bataya gaya hai, ya server ko [source se](#quick-start-from-source) chalayein. Isay
> macOS par test kiya gaya hai; Windows aur Linux par best effort hai.

Server yeh tools deta hai: app tools (launch, health, discovery, interface state, plan limits, reconnect),
chart tools (state, symbol, timeframe, chart type, visible range, scrolling), market data tools (bars,
quotes, symbol info aur search), indicator tools (list, search, add, remove, inputs, visibility, values),
Pine Script tools (editor aur saved scripts, compile, rule-based fixes ke saath smart compile, offline
analysis, console, aur woh lines, labels, boxes aur tables jo scripts draw karti hain), Strategy Tester tools
(results, trades, equity), drawing, alert aur watchlist tools, layout, multi-chart aur tab tools, bar replay,
screenshots, low-level interface tools (click, hover, type, keys, scroll, find, panels, fullscreen, aur chart
page mein JavaScript jab aap ijazat dein) aur `batch_run`, jo ek hi call mein kai tools chalata hai. Yeh
resources bhi deta hai (app health, chart state aur bars, Pine source aur aakhri compile result, strategy
report, active watchlist), har ek us tool ke saath jis ke saath woh apna data share karta hai, aur aam kaamon
ke liye paanch prompts. Ek web dashboard calls ko live dikhata hai aur tools ko haath se chalata hai (dekhein
[Dashboard](#dashboard)).

Fehrist: [Apni AI app se keh kar install karein](#install-by-asking-your-ai-app), [Install](#install),
[Apni AI app connect karein](#connect-your-ai-app), [Remote clients aur tunnels](#remote-clients-and-tunnels),
[Source se quick start](#quick-start-from-source), [Istemal](#use-it),
[Troubleshooting](#troubleshooting), [Dashboard](#dashboard), [Contributing](#contributing).

## <a id="install-by-asking-your-ai-app"></a>Apni AI app se keh kar install karein

Aap ko khud koi command type karne ki zaroorat nahi. Agar aap ki AI app aap ke computer par commands chala
sakti hai, jaise Claude Code, Cursor, VS Code, Windsurf, Gemini CLI aur Codex CLI chala sakti hain, to woh
aap ke liye setup kar sakti hai. Pehle:

1. [TradingView Desktop](https://www.tradingview.com/desktop/) install karein aur login karein.
2. [Node.js](https://nodejs.org) (LTS version) install karein, agar abhi tak nahi hai.

Phir yeh prompt copy karein, apni AI app mein paste karein aur send kar dein:

```text
Mere liye TradingView MCP server install karo. Yeh npm package tradingview-desktop-mcp hai
(https://github.com/Mochamad-Rizky/tradingview-desktop-mcp). Yeh steps follow karo aur har step mujhe
aasaan alfaaz mein samjhao:

1. Check karo ke Node.js 20.19 ya us se naya installed hai. Agar nahi hai to ruk jao aur mujhe batao ke isay kaise install karoon.
2. "npx -y tradingview-desktop-mcp config <client>" chalao, jahan <client> woh app hai jis mein tum
   chal rahe ho (claude-code, cursor, vscode, windsurf, gemini-cli ya codex-cli). Jo yeh print kare
   us ke mutabiq server ko meri configuration mein add karo, aur jo doosre servers pehle se hain unhein rehne do.
3. TradingView ko "npx -y tradingview-desktop-mcp launch" se start karo. Agar yeh kahe ke TradingView
   pehle se debug port ke baghair chal raha hai, to pehle mujh se poocho, aur sirf meri ijazat ke baad
   isay --restart ke saath dobara chalao, kyunke is se TradingView band ho jata hai aur meri unsaved changes zaaya ho sakti hain.
4. "npx -y tradingview-desktop-mcp doctor" chalao aur mujhe batao ke saare checks pass hue ya nahi. Agar
   chart check fail ho, to mujhe kaho ke TradingView mein chart tab ko saamne laoon.
5. Mujhe batao ke TradingView tools nazar aane se pehle kya mujhe tumhein restart karna hoga, ya nayi chat kholni hogi.
```

Jab yeh ho jaye, agar us ne kaha ho to app restart karein ya nayi chat kholein, aur poochein "Check karo ke
TradingView connected hai." Phir [neeche diye gaye prompts](#try-these-prompts) try karein.

Claude Desktop use kar rahe hain? Woh commands nahi chala sakta, lekin Claude Code, Cursor aur upar wali
doosri apps aap ke liye isay set up kar sakti hain: prompt ke aakhir mein "Isay Claude Desktop ke liye set
up karo (config claude-desktop), is app ke liye nahi." add kar dein. ChatGPT aur OpenAI API ko ek tunnel
chahiye, jo aap haath se set up karte hain (dekhein
[Remote clients aur tunnels](#remote-clients-and-tunnels)). Agar assistant atak jaye, to neeche diye gaye
steps khud follow karein.

## <a id="install"></a>Install

Aap ko chahiye:

- TradingView Desktop, installed aur logged in.
- Node.js 20.19 ya us se naya, jo `npx` deta hai.

Aur kuch install nahi hota: neeche diye gaye clients server ko `npx -y tradingview-desktop-mcp` se start karte
hain, jo pehli dafa use par package download kar leta hai. TradingView ko us ke debug port ke saath start
karein. `launch` command app ko dhoond kar isi tarah start karti hai:

```sh
npx -y tradingview-desktop-mcp launch
```

TradingView sirf ek instance chalne deta hai. Agar yeh pehle se debug port ke baghair chal raha ho, to `launch`
ruk jati hai aur yahi batati hai; `launch --restart` isay araam se band kar ke port ke saath dobara start karti
hai, aur ho sakta hai TradingView pehle aap se changes save karne ka kahe. Check karein ke server app tak
pohanch sakta hai:

```sh
npx -y tradingview-desktop-mcp doctor
```

Jab tak chart tab background mein ho, New tab page ya kisi aisi doosri tab ke peeche jis mein chart nahi,
`doctor` ka chart check fail hota hai, is liye chart tab ko saamne le aayein.
`npx -y tradingview-desktop-mcp --help` options ki list deta hai, aur [.env.example](../../.env.example)
environment variables ki.

## <a id="connect-your-ai-app"></a>Apni AI app connect karein

`config <client>` kisi client ka configuration snippet print karti hai aur batati hai ke woh kahan jata hai.
Neeche har tutorial mein wahi snippet, us app ke steps aur kaam na karne ki soorat mein kya karna hai, sab
maujood hai.

| Client                                         | Snippet print karein                                   |
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

Default transport stdio hai, jahan stdout sirf MCP messages le jata hai aur logs stderr par jate hain. Pehle
saat clients server ko khud start karte hain. Windows par, jo client `npx` ko seedha start nahi kar sakta
use `cmd /c npx` wali form chahiye, jo `config` Windows par chalne par (ya `--platform win32` ke saath) print
karti hai. `--profile` ek [tool profile](#tool-profiles) server tak pohanchata hai.

### <a id="remote-clients-and-tunnels"></a>Remote clients aur tunnels

ChatGPT aur OpenAI API aap ke computer par koi program start nahi kar sakte. Woh server tak ek public HTTPS
address ke zariye pohanchte hain, is liye aap isay HTTP par chalate hain aur us ke aage ek tunnel lagate hain.
Is tarah ek aisa server internet par aa jata hai jo aap ke logged-in TradingView ko control kar sakta hai:
`--profile readonly`, ek mazboot token (`TV_MCP_AUTH_TOKEN`), `--allowed-hosts` mein tunnel ka public host
(`TV_MCP_ALLOWED_HOSTS`), aur `--no-dashboard` use karein, taa ke dashboard ki files tunnel ke zariye serve na
hon. [ChatGPT](../clients/chatgpt.md) aur
[OpenAI API](../clients/openai-api.md) ke tutorials yeh step by step samjhate hain, aur
[SECURITY.md](../../SECURITY.md#tunnels-and-remote-clients) batata hai ke ek read-only token phir bhi kis cheez tak pohanch sakta hai.

## <a id="quick-start-from-source"></a>Source se quick start

Published package ki jagah checkout chalane ke liye, server build karne ko aap ko Node.js 24 chahiye
(`nvm use` `.nvmrc` parhta hai) aur [pnpm](https://pnpm.io), jis ka version `package.json` mein pinned hai.
Built server Node.js 20.19 ya us se naye par chalta hai.

```sh
git clone https://github.com/Mochamad-Rizky/tradingview-desktop-mcp.git
cd tradingview-desktop-mcp
pnpm install && pnpm build
node packages/server/dist/cli.js launch
node packages/server/dist/cli.js doctor
```

`node packages/server/dist/cli.js config <client> --local` is checkout ke liye kisi client ka snippet print
karti hai, `npx` ki jagah `node` aur `cli.js` ke absolute path ke saath. JSON configuration wale client ke
liye entry kuch is tarah dikhti hai:

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

Ek HTTP transport bhi hai (`--transport http`); isay use karne se pehle [SECURITY.md](../../SECURITY.md) parh
lein.

## <a id="use-it"></a>Istemal

Upar bataye gaye tareeqe se ek MCP client connect karein, TradingView ko us ke debug port ke saath chalta
rakhein, aur jo chahiye saada alfaaz mein maang lein. Assistant khud tools chunta aur call karta hai, is liye
aap ko un ke naam jaanne ki zaroorat nahi. [Tool reference](../tools.md) har tool ko us ke inputs aur un
profiles ke saath list karta hai jin mein woh shamil hai.

### <a id="try-these-prompts"></a>Yeh prompts try karein

Neeche har prompt [docs/examples.md](../examples.md) ki ek misaal hai, jo dikhata hai ke assistant kaun si
tool calls karta hai aur un ke results kya aate hain; is mein teen se lambi lists kaat di gayi hain, har call
ka duration (`durationMs`) nikaal diya gaya hai aur screenshot dikhane ki bajaye ek note mein us ka naam diya
gaya hai. Excerpts unhi results ki lines hain, aur `…` wahan lagta hai jahan result ke doosre hisson ki lines
chhor di gayi hain. Values synthetic hain: yeh ek fake TradingView app se aati hain jis mein ek farzi
NASDAQ:AAPL chart hai, is liye kuch bhi market data nahi aur kuch bhi kisi account se nahi aata; phir bhi
results ki shape wahi hai jo server deta hai, halanke backtest wali misaal ke peeche Strategy Tester report
abhi tak asal app se nahi parhi gayi.

**"Mere chart par kya dikh raha hai? Mujhe symbol, timeframe aur us par lage indicators
batao."** Assistant `chart_get_state` se chart parhta hai
([tafseel](../examples.md#1-read-the-chart)):

```json
"symbol": "NASDAQ:AAPL",
"resolution": "1D",
"chartTypeName": "candles",
```

**"Mujhe aakhri 3 daily candles dikhao."** Yeh `data_get_ohlcv` se bars parhta hai
([tafseel](../examples.md#3-read-the-last-candles)):

```json
"timeIso": "2024-10-27T00:00:00Z",
"open": 103.58,
"close": 103.42,
```

**"Mere chart par MACD add karo."** Jis chart par plan ki ijazat jitne indicators pehle se hon, wahan
`indicator_add` kuch add nahi karta aur limit report karta hai, aur jagah banane ke liye aap ka koi indicator
hatane ke liye aap ki confirmation chahiye ([tafseel](../examples.md#5-add-an-indicator-to-a-full-chart)):

```json
"code": "PLAN_LIMIT",
"message": "The chart holds as many indicators as the plan allows (2)",
```

**"Ek Pine Script indicator likho jo close ka 9-bar aur 21-bar moving average plot kare, aur check karo ke
yeh compile hota hai."** Yeh `pine_new` se script ko Pine Editor mein daalta hai aur
`pine_compile` se compile karta hai ([tafseel](../examples.md#6-write-and-compile-a-pine-script)):

```json
"success": true,
"errors": [],
"warnings": [],
```

**"Mere Pine Editor wala script compile nahi ho raha. Kya tum isay theek kar sakte ho?"** `pine_smart_compile`
script compile karta hai, jin errors ko pehchanta hai un ke liye rule-based fixes lagata hai, jaise v6 script
mein Pine v4 ke names, aur dobara compile karta hai, editor ko badle baghair
([tafseel](../examples.md#7-fix-a-pine-script-with-smart-compile)):

```json
"message": "Could not find function or function reference 'study'",
…
"applied": ["Replace study( with indicator(", "Replace rsi( with ta.rsi("]
…
"writtenBack": false
```

**"Mere chart wali strategy ne backtest mein kaisa perform kiya?"** Yeh Strategy Tester ko
`strategy_get_results` aur `strategy_get_trades` se parhta hai
([tafseel](../examples.md#8-read-backtest-results)):

```json
"netProfit": 155,
"totalTrades": 3,
"percentProfitable": 66.67,
"profitFactor": 4.1,
```

**"Mere chart par 102.80 par support line draw karo."** Yeh `drawing_create` se horizontal line draw karta hai,
aur `drawing_list` isay aap ki apni drawings ke saath dikhata hai, is nishaan ke saath ke yeh is session ne
draw ki hai ([tafseel](../examples.md#9-draw-a-support-line)):

```json
"id": "DRW001",
"shape": "horizontal_line",
"text": "Support",
"createdByServer": true
```

**"Jab Apple 110 cross kare to mujhe alert karna."** `alert_create` aap ke TradingView account mein price alert
set karta hai ([tafseel](../examples.md#10-create-a-price-alert)). Jab plan mein pehle se utne alerts hon
jitne ki ijazat hai, to yeh kuch nahi banata aur limit report karta hai, aur `alert_list` woh alerts dikhata
hai jin se plan bhara hua hai ([tafseel](../examples.md#11-create-an-alert-when-the-plan-is-full)):

```json
"symbol": "NASDAQ:AAPL",
"condition": "crossing",
"price": 110,
"expirationIso": "2024-11-26T00:00:00Z"
```

**"Yeh symbols meri watchlist mein add karo: NYSE:IBM, FX:EURUSD, NASDAQ:MSFT aur NASDAQ:MSTF."**
`watchlist_add_bulk` har symbol ko TradingView ki symbol search se check karta hai, naye symbols add karta hai
aur batata hai ke baaqi ko kyun skip kiya ([tafseel](../examples.md#12-add-symbols-to-a-watchlist)):

```json
"added": ["NYSE:IBM", "FX:EURUSD"],
…
{ "symbol": "NASDAQ:MSFT", "reason": "already_listed" },
{ "symbol": "NASDAQ:MSTF", "reason": "unknown" }
```

**"Mujhe apne chart ke 2024-06-03 se bar replay par practice karne do: paanch bars aage chalo, batao hum kahan
hain, phir replay khatam kar do."** Yeh `replay_start` se bar replay shuru karta hai, `replay_step` se aage
barhta hai, `replay_status` se parhta hai ke replay kahan hai aur `replay_stop` se us se nikalta hai. Koi
trading nahi hoti: koi bhi tool orders place nahi karta ([tafseel](../examples.md#13-practice-with-bar-replay)):

```json
"dateIso": "2024-06-07T00:00:00Z",
"stepped": 5,
…
"position": null,
"realizedPL": null
```

**"Mere chart ka screenshot lo."** `screenshot_capture` picture ko us ke size ke saath image ki shakal mein
assistant ko de deta hai, aur disk par kuch nahi likhta
([tafseel](../examples.md#14-take-a-screenshot)):

```json
"data": { "target": "chart", "format": "jpeg", "width": 1180, "height": 640, "bytes": 3100 },
"meta": { "via": "cdp", "warnings": [] }
```

Server apne paanch prompts bhi deta hai, jinhein MCP prompts support karne wala client aap ke chunne ke liye
list karta hai: `analyze_current_chart`, `multi_timeframe_review`, `write_and_backtest_strategy`,
`debug_pine_script` aur `replay_practice_session`. Har ek assistant ko batata hai ke kaun se tools call karne
hain, kis tarteeb mein, aur aakhir mein kya report karna hai. `replay_practice_session` bar replay par ek
practice session chalata hai: assistant maazi mein bar by bar aage barhta hai, har step par aap se poochta hai
ke aap long jayenge, short jayenge ya flat rahenge, in farzi trades ka journal un prices par rakhta hai jo woh
chart se parhta hai, aur un ka profit ya loss nikalta hai. Yeh pehle check karta hai ke kya aap ka koi replay
chal raha hai, aur kuch bhi badalne se pehle aap se poochta hai ke us ka kya karna hai; aakhir mein yeh sirf
woh replay band karta hai jo is ne khud shuru kiya, aap ka kabhi nahi.

### <a id="safety"></a>Safety

Jo tools aap ka chart, scripts ya account badalte hain, woh pehle se aap ki cheezon ke saath ehtiyaat baratte
hain. Pine Editor mein unsaved text ko replace karna (siwaye us unsaved edit ke jo server ke isi session ne
khud wahan kiya ho), kisi aise script ka naya version save karna jo is session ne nahi banaya, aur chart par
pehle se maujood indicator hatana, in sab ke liye `confirm: true` chahiye, jo assistant ko sirf aap ki
razamandi ke baad pass karna chahiye. Yahi cheez kisi aisi drawing, alert, watchlist symbol ya tab ko hatane
par bhi lagu hoti hai jo is session ne na banayi, na add ki, na kholi ho, chart ki saari drawings hatane par,
unsaved changes wale layout se hat kar doosre par jaane par, aur aise multi-chart layout par switch karne par
jis mein tab mein dikhne wale charts se kam charts hon, kyunke us ka agla save baaqi charts ko gira dega. Koi
bhi plan limit, jaise chart par indicators ki tadaad, saved scripts, alerts ya layout ke charts, kuch bhi add
karne se pehle check hoti hai aur limit ke saath `PLAN_LIMIT` error ki soorat mein report hoti hai; jab aap
ke TradingView build par limit parhi na ja sake, to tool kuch nahi karta aur yahi batata hai. Server kisi limit
ko bypass nahi karta. Tools pehle check karte hain ke kis cheez se TradingView apna upgrade dialog, ya koi aur
apna dialog, kholega, aur us ki jagah inkaar kar dete hain, lekin kuch prompts phir bhi reh jate hain jin ka
yeh checks andaza nahi laga sakte:
`layout_switch` ko kam charts wale plan par saved multi-chart layout ke liye, aise layout ke liye jise
TradingView ka server limit se zyada keh kar reject kar de, aur aise layout ke liye jise TradingView ki apni
andaruni list limit se upar mark kare jabke `layout_list` na kare, upgrade prompt mil sakta hai; `layout_new`
ko TradingView ka message mil sakta hai jab woh checks ke baad naya layout reject kar de; aur `tab_close` ko
"Close tab?" dialog mil sakta hai aisi page ke liye jo yeh batane mein TradingView ke intezar se zyada waqt
le ke us ke layout mein unsaved changes hain ya nahi, ya jo recording in progress report kare. Low-level
`ui_*` tools wahi click aur type karte hain jo aap kahein, is liye design ke mutabiq woh TradingView ke dialogs
khol sakte hain. Server koi script delete ya rename nahi karta.

Koi tool orders place nahi karta: bar replay practice ke liye hai, aur assistant practice trades ko conversation
hi mein rakhta hai. Screenshots client ko images ki shakal mein jate hain, aur server in mein se koi bhi disk
par nahi likhta.
`ui_evaluate`, jo chart page mein JavaScript chalata hai, tab tak off rehta hai jab tak aap server ko
`--allow-eval` (`TV_MCP_ALLOW_EVAL=true`) ke saath start na karein.

### <a id="tool-profiles"></a>Tool profiles

By default server apne saare 83 tools deta hai (`--profile full`). Kuch clients sirf mehdood tadaad mein tools
qubool karte hain (Cursor 40 se upar warning deta hai). Un ke liye `--profile core` 40 zaroori tools ka chhota
set deta hai, aur `--profile readonly` sirf woh 37 tools jo parhte hain. `--tools` `chart_*,data_*` jaise name
patterns leta hai aur profile ko mazeed tang karta hai: tool ka profile mein hona aur kisi pattern se match
karna zaroori hai, is liye `--profile core --tools 'pine_*'` phir bhi `pine_open` aur `pine_save` ko chhor
deta hai, jo core tools nahi hain; default profile ke saath `--tools` akela hi tools chunta hai.
Kuch descriptions aur hints un tools ka naam lete hain jo `core` chhor deta hai, jaise `pine_open` aur
`pine_save`, jinhein assistant `core` ke tehat call nahi kar sakta. Resources tools ke peeche chalte hain: har
resource sirf us tool ke saath diya jata hai jis ke saath woh apna data share karta hai, jaise
`tradingview://pine/source` `pine_get_source` ke saath, is liye `--tools 'chart_*'` chart state deta hai aur
Pine Editor ka kuch nahi.

[Tool reference](../tools.md) har tool ko us ke inputs aur un profiles ke saath list karta hai jin mein woh shamil hai.

## <a id="troubleshooting"></a>Troubleshooting

[docs/troubleshooting.md](../troubleshooting.md) har error code samjhata hai aur batata hai ke kya karna hai
jab TradingView na mile, debug port busy ho, client tools na dikhaye ya tunnel koi request reject kare.
Sab se pehle `npx -y tradingview-desktop-mcp doctor` chalayein.

## <a id="dashboard"></a>Dashboard

Server ke saath ek web dashboard aata hai jis se aap dekh sakte hain ke aap ka assistant kya kar raha hai aur
kisi tool ko haath se try kar sakte hain. Is ke liye alag install ki zaroorat nahi: published package mein yeh
shamil hai, aur `pnpm build` isay checkout ke server mein build kar deta hai.

![Status page: TradingView reachable hai, chart mil gaya hai aur app ready hai, server ki maloomat, aur plan limits](../images/dashboard-status.png)

### <a id="open-it"></a>Isay kholein

- **HTTP transport:** server ko token ke saath start karein aur `http://127.0.0.1:8787/` kholein. Is mode mein
  dashboard by default on hota hai; `--no-dashboard` (`TV_MCP_DASHBOARD=false`) isay off karta hai.

  ```sh
  TV_MCP_AUTH_TOKEN="$(openssl rand -hex 32)" npx -y tradingview-desktop-mcp --transport http
  ```

  Checkout se, is ki jagah `node packages/server/dist/cli.js --transport http` chalayein.

- **stdio ke saath saath:** jo MCP client server ko stdio par start karta hai us ka bhi dashboard ho sakta hai.
  Us ki configuration mein `--dashboard` (`TV_MCP_DASHBOARD=true`) aur `TV_MCP_AUTH_TOKEN` add karein. Dashboard
  apne alag address par listen karta hai, `127.0.0.1:8787` jab tak aap `--host` aur `--port` set na karein, aur
  `/mcp` serve nahi karta. Token ke baghair, ya jab port pehle se istemal mein ho, dashboard off rehta hai aur
  server ek warning log karta hai, lekin MCP server chalta rehta hai. Client jo calls karta hai woh live log mein nazar aati hain.

Server start hone par stderr par dashboard ka address print karta hai. Token woh kabhi print nahi karta.

### <a id="the-token"></a>Token

Page kuch bhi dikhane se pehle token (`TV_MCP_AUTH_TOKEN`) maangta hai. Isay paste karein, ya ek dafa
`http://127.0.0.1:8787/#token=<token>` kholein: page fragment se token parh leta hai aur isay address se hata
deta hai, aur fragment kabhi server ko nahi bheja jata. Page token ko `sessionStorage` mein rakhta hai, is liye
tab band karne par yeh khatam ho jata hai, aur yeh token sirf `Authorization: Bearer <token>` ki shakal mein
bhejta hai, kabhi URL mein nahi. Jab server kisi aur token ke saath restart ho, to page dobara poochta hai.
Dekhein [SECURITY.md](../../SECURITY.md#the-dashboard).

### <a id="what-it-shows"></a>Yeh kya dikhata hai

![Live log: tool calls ka table, sab se naya upar, un ke time, tool, origin, status aur duration ke saath, aur upar search aur filters](../images/dashboard-log.png)

- **Status** dikhata hai ke TradingView reachable hai ya nahi (aur agar nahi to isay kaise start karein),
  server kaise chal raha hai, plan limits aur haaliya calls.
- **Log** server ki chalayi har tool call ko stream karta hai, chahe woh MCP client ne ki ho ya dashboard ne,
  tool name ke filter, pause, clear aur har call ki tafseel ke saath. Connection toot jaye to yeh
  "Reconnecting…" dikhata hai aur wahin se shuru karta hai jahan ruka tha. Dashboard ki har khuli tab server
  ke saath ek event stream rakhti hai, aur browser ek host se taqreeban chhe connections ki ijazat deta hai, is
  liye bohat si dashboard tabs khuli hon to nayi tab ko free connection ka intezar karna par sakta hai: jo tabs
  use nahi kar rahe unhein band kar dein.
- **Tools** server ke diye gaye tools ko un ke inputs ke saath list karta hai, aur kisi ek ko haath se chalata
  hai. Result waise hi dikhaya jata hai jaise wapas aaya, lamba JSON "Show all" ke peeche collapsed aur images
  images ki shakal mein.

![Tools page: baayein taraf search aur filters ke saath tool list, aur daayein taraf chart_get_state us ki description, maloomat aur input fields ke saath](../images/dashboard-tools.png)

Dashboard se run asal tool call hota hai. Yeh MCP call wali hi registry se guzarta hai, is liye wahi schemas,
profile, `confirm` rules aur plan limit checks lagu hote hain, aur yeh log mein bhi nazar aata hai. Jo tool
read-only nahi, use chalane se pehle dashboard aap se confirmation maangta hai.

### <a id="the-api"></a>API

Page server se ek chhoti si API ke zariye baat karta hai, jise aap `curl` aur token ke saath khud bhi call kar
sakte hain. Har route ko `Authorization: Bearer <token>` chahiye, aur server `Host` aur `Origin` ko waise hi
check karta hai jaise `/mcp` ke liye.

| Route                    | Kya karta hai                                                                    |
| ------------------------ | -------------------------------------------------------------------------------- |
| `GET /api/info`          | Version, transport, profile, tools ki tadaad aur start time                      |
| `GET /api/health`        | Health report: TradingView reachable hai ya nahi                                 |
| `GET /api/tools`         | Diye gaye tools, un ke schemas aur annotations ke saath                          |
| `POST /api/tools/<name>` | `{"arguments": {...}}` ke saath tool chalata hai, origin `dashboard` ke taur par |
| `GET /api/events`        | Tool calls ke server-sent events; `?limit=` set karta hai ke kitne replay hon    |

Page ki apni files, `/` par, ko token nahi chahiye aur un mein koi data nahi hota.

## <a id="contributing"></a>Contributing

Local setup, test levels, commit conventions aur release kaise banta hai, is ke liye
[CONTRIBUTING.md](../../CONTRIBUTING.md) dekhein, aur testing guide ke liye [docs/testing.md](../testing.md). Koi
vulnerability report karne ke liye [SECURITY.md](../../SECURITY.md) follow karein.

## <a id="disclaimer"></a>Disclaimer

Yeh project TradingView, Inc. se na wabasta hai, na us ki taraf se endorsed hai, na sponsored. TradingView apne
maalik ka trademark hai. Yahan kuch bhi financial advice nahi hai. Tools woh badalte hain jo app dikhati hai aur
us ke controls tak pohanch sakte hain, is liye jo aap automate karte hain aur TradingView ki terms of use ki
paabandi, dono ki zimmedari aap par hai.

## <a id="license"></a>License

[MIT license](../../LICENSE) ke tehat release kiya gaya.
