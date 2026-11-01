# tradingview-desktop-mcp

[English](../../README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Türkçe](README.tr.md) · [Русский](README.ru.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Українська](README.uk.md) · [Polski](README.pl.md) · [Português (Brasil)](README.pt-BR.md) · [العربية](README.ar.md) · [فارسی](README.fa.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Ελληνικά](README.el.md) · [മലയാളം](README.ml.md) · [Roman Urdu](README.ur-Latn.md) · **Română**

[![npm](https://img.shields.io/npm/v/tradingview-desktop-mcp)](https://www.npmjs.com/package/tradingview-desktop-mcp)
[![CI](https://github.com/Mochamad-Rizky/tradingview-desktop-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Mochamad-Rizky/tradingview-desktop-mcp/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/Mochamad-Rizky/tradingview-desktop-mcp/graph/badge.svg)](https://codecov.io/gh/Mochamad-Rizky/tradingview-desktop-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../../LICENSE)

> Aceasta este o traducere a [README-ului în engleză](../../README.md). Dacă cele două diferă, versiunea în engleză este cea de referință.

<p align="center">
  <a href="../media/promo.mp4"><img src="../media/teaser.gif" width="49%" alt="Videoclipul de prezentare: un asistent citește un grafic, trasează o linie de suport, scrie un Pine Script și setează o alertă de preț"></a>
  <a href="../media/tutorial.mp4"><img src="../media/tutorial-poster.jpg" width="49%" alt="Tutorialul de configurare: configurare în cinci pași"></a>
</p>

<p align="center">
  <a href="../media/promo.mp4"><b>▶ Urmărește prezentarea</b></a> (0:48) &nbsp;·&nbsp;
  <a href="../media/tutorial.mp4"><b>▶ Urmărește tutorialul de configurare</b></a> (1:53)<br>
  <sub>Ambele videoclipuri folosesc un grafic inventat, nu date de piață.</sub>
</p>

Un server [MCP](https://modelcontextprotocol.io) care le permite asistenților AI să citească și să
controleze aplicația TradingView Desktop de pe propriul calculator. Serverul comandă aplicația în
care ești deja autentificat prin Chrome DevTools Protocol, folosind portul de depanare pe care
aplicația îl deschide când pornește cu `--remote-debugging-port`. Automatizează doar aplicația
locală: nu se autentifică în locul tău, nu ocolește limitele planului și nu apelează serverele
TradingView.

> **Stare: pre-1.0.** Numele uneltelor și opțiunile se pot schimba înainte de 1.0. Instalează
> pachetul din npm, ca mai jos, sau rulează serverul [din sursă](#quick-start-from-source). A fost
> testat pe macOS; Windows și Linux sunt suportate în măsura posibilului.

Serverul oferă unelte pentru aplicație (lansare, stare de sănătate, descoperire, starea interfeței,
limitele planului, reconectare), unelte pentru grafic (stare, simbol, interval de timp, tip de
grafic, intervalul vizibil, derulare), unelte pentru date de piață (bare, cotații, informații despre
simboluri și căutare), unelte pentru indicatori (listare, căutare, adăugare, eliminare, parametri,
vizibilitate, valori), unelte Pine Script (editorul și scripturile salvate, compilare, compilare
inteligentă cu corecturi bazate pe reguli, analiză offline, consola, precum și liniile, etichetele,
casetele și tabelele pe care le desenează scripturile), unelte Strategy Tester (rezultate,
tranzacții, equity), unelte pentru desene, alerte și watchlist-uri, unelte pentru layout-uri,
multi-chart și file, bar replay, capturi de ecran, unelte de interfață de nivel scăzut (clic, hover,
tastare, taste, derulare, căutare, panouri, ecran complet și JavaScript în pagina graficului când
permiți acest lucru) și `batch_run`, care rulează mai multe unelte într-un singur apel. Oferă de
asemenea resurse (starea de sănătate a aplicației, starea și barele graficului, sursa Pine și
ultimul rezultat al compilării, raportul strategiei, watchlist-ul activ), fiecare împreună cu
unealta cu care își împarte datele, și cinci prompturi pentru sarcini obișnuite. Un dashboard web
afișează apelurile în timp real și rulează unelte manual (vezi [Dashboard](#dashboard)).

Cuprins: [Instalare cerând aplicației tale AI](#install-by-asking-your-ai-app), [Instalare](#install),
[Conectează aplicația AI](#connect-your-ai-app), [Clienți la distanță și tuneluri](#remote-clients-and-tunnels),
[Pornire rapidă din sursă](#quick-start-from-source), [Utilizare](#use-it),
[Depanare](#troubleshooting), [Dashboard](#dashboard), [Contribuții](#contributing).

## <a id="install-by-asking-your-ai-app"></a>Instalare cerând aplicației tale AI

Nu trebuie să tastezi nicio comandă. Dacă aplicația ta AI poate rula comenzi pe calculatorul tău,
cum pot Claude Code, Cursor, VS Code, Windsurf, Gemini CLI și Codex CLI, poate face configurarea în
locul tău. Mai întâi:

1. Instalează [TradingView Desktop](https://www.tradingview.com/desktop/) și autentifică-te.
2. Instalează [Node.js](https://nodejs.org) (versiunea LTS), dacă nu îl ai deja.

Apoi copiază acest prompt, lipește-l în aplicația ta AI și trimite-l:

```text
Instalează pentru mine serverul MCP pentru TradingView. Este pachetul npm tradingview-desktop-mcp
(https://github.com/Mochamad-Rizky/tradingview-desktop-mcp). Urmează pașii de mai jos și explică-mi
fiecare pas în cuvinte simple, în limba română:

1. Verifică dacă este instalat Node.js 20.19 sau mai nou. Dacă nu este, oprește-te și spune-mi cum
   să îl instalez.
2. Rulează "npx -y tradingview-desktop-mcp config <client>", unde <client> este aplicația în care
   rulezi (claude-code, cursor, vscode, windsurf, gemini-cli sau codex-cli). Fă ce afișează
   comanda pentru a adăuga serverul în configurația mea și păstrează celelalte servere care sunt
   deja acolo.
3. Pornește TradingView cu "npx -y tradingview-desktop-mcp launch". Dacă spune că TradingView
   rulează deja fără portul de depanare, întreabă-mă mai întâi și, doar dacă sunt de acord,
   rulează din nou comanda cu --restart, pentru că aceasta închide TradingView și aș putea pierde
   modificările nesalvate.
4. Rulează "npx -y tradingview-desktop-mcp doctor" și spune-mi dacă toate verificările trec. Dacă
   verificarea graficului eșuează, spune-mi să aduc în față fila graficului în TradingView.
5. Spune-mi dacă trebuie să te repornesc sau să deschid o conversație nouă înainte să apară
   uneltele TradingView.
```

Când a terminat, repornește aplicația sau deschide o conversație nouă dacă ți s-a spus asta și
întreabă „Verifică dacă TradingView este conectat.” Apoi încearcă [prompturile de mai jos](#try-these-prompts).

Folosești Claude Desktop? Nu poate rula comenzi, dar Claude Code, Cursor și celelalte aplicații de
mai sus îl pot configura pentru tine: adaugă „Configurează-l pentru Claude Desktop (config
claude-desktop), nu pentru această aplicație.” la sfârșitul promptului. ChatGPT și OpenAI API au
nevoie de un tunel, pe care îl configurezi manual (vezi
[Clienți la distanță și tuneluri](#remote-clients-and-tunnels)). Dacă asistentul se blochează, urmează
singur pașii de mai jos.

## <a id="install"></a>Instalare

Ai nevoie de:

- TradingView Desktop, instalat și cu contul autentificat.
- Node.js 20.19 sau mai nou, care furnizează `npx`.

Nu se instalează nimic altceva: clienții de mai jos pornesc serverul cu
`npx -y tradingview-desktop-mcp`, care descarcă pachetul la prima utilizare. Pornește TradingView cu
portul său de depanare. Comanda `launch` găsește aplicația și o pornește astfel:

```sh
npx -y tradingview-desktop-mcp launch
```

TradingView permite o singură instanță. Dacă rulează deja fără portul de depanare, `launch` se
oprește și îți spune acest lucru; `launch --restart` o închide politicos și o pornește din nou cu
portul, iar TradingView îți poate cere mai întâi să salvezi modificările. Verifică dacă serverul
poate ajunge la aplicație:

```sh
npx -y tradingview-desktop-mcp doctor
```

`doctor` pică verificarea graficului cât timp fila graficului este în fundal, în spatele paginii New
tab sau al altei file fără grafic, așa că adu fila graficului în față.
`npx -y tradingview-desktop-mcp --help` listează opțiunile, iar [.env.example](../../.env.example)
variabilele de mediu.

## <a id="connect-your-ai-app"></a>Conectează aplicația AI

`config <client>` afișează fragmentul de configurație al unui client și spune unde trebuie pus.
Fiecare tutorial de mai jos conține același fragment, pașii pentru aplicația respectivă și ce să faci
când nu funcționează.

| Client                                         | Afișează fragmentul                                    |
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

Transportul implicit este stdio, unde stdout transportă doar mesaje MCP, iar logurile merg în
stderr. Primii șapte clienți pornesc singuri serverul. Pe Windows, un client care nu poate porni
`npx` direct are nevoie de forma `cmd /c npx`, pe care `config` o afișează când rulează pe Windows
(sau cu `--platform win32`). `--profile` transmite serverului un [profil de unelte](#tool-profiles).

### <a id="remote-clients-and-tunnels"></a>Clienți la distanță și tuneluri

ChatGPT și OpenAI API nu pot porni un program pe calculatorul tău. Ele ajung la server printr-o
adresă HTTPS publică, așa că îl rulezi prin HTTP și pui un tunel în fața lui. Astfel ajunge pe
internet un server care îți poate controla TradingView-ul în care ești autentificat: folosește
`--profile readonly`, un token puternic (`TV_MCP_AUTH_TOKEN`), hostul public al tunelului în
`--allowed-hosts` (`TV_MCP_ALLOWED_HOSTS`) și `--no-dashboard`, ca fișierele dashboard-ului să nu fie
servite prin tunel. Tutorialele pentru [ChatGPT](../clients/chatgpt.md) și
[OpenAI API](../clients/openai-api.md) te ghidează pas cu pas, iar
[SECURITY.md](../../SECURITY.md#tunnels-and-remote-clients) enumeră ce poate accesa în continuare un token
read-only.

## <a id="quick-start-from-source"></a>Pornire rapidă din sursă

Pentru a rula o copie locală a depozitului în locul pachetului publicat, ai nevoie de Node.js 24
pentru a compila serverul (`nvm use` citește `.nvmrc`) și de [pnpm](https://pnpm.io), a cărui
versiune este fixată în `package.json`. Serverul compilat rulează pe Node.js 20.19 sau mai nou.

```sh
git clone https://github.com/Mochamad-Rizky/tradingview-desktop-mcp.git
cd tradingview-desktop-mcp
pnpm install && pnpm build
node packages/server/dist/cli.js launch
node packages/server/dist/cli.js doctor
```

`node packages/server/dist/cli.js config <client> --local` afișează fragmentul unui client pentru
această copie locală, cu `node` și calea absolută a lui `cli.js` în locul lui `npx`. Pentru un
client cu configurație JSON, intrarea arată astfel:

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

Există și un transport HTTP (`--transport http`); citește [SECURITY.md](../../SECURITY.md) înainte să îl
folosești.

## <a id="use-it"></a>Utilizare

Conectează un client MCP așa cum este descris mai sus, cu TradingView rulând cu portul de depanare,
și cere ce vrei în cuvinte simple. Asistentul alege uneltele și le apelează, așa că nu trebuie să le
știi numele. [Referința uneltelor](../tools.md) listează fiecare unealtă cu parametrii ei și
profilurile din care face parte.

### <a id="try-these-prompts"></a>Încearcă aceste prompturi

Fiecare prompt de mai jos este unul dintre exemplele din [docs/examples.md](../examples.md), care
arată apelurile de unelte pe care le face asistentul și rezultatele, cu listele mai lungi de trei
elemente scurtate, durata fiecărui apel (`durationMs`) omisă și o captură de ecran menționată într-o
notă în loc să fie afișată. Extrasele sunt rânduri din aceste rezultate, iar `…` marchează locul în
care au fost omise rânduri din alte părți ale unui rezultat. Valorile sunt sintetice: provin dintr-o
aplicație TradingView falsă, cu un grafic NASDAQ:AAPL inventat, așa că nimic nu reprezintă date de
piață și nimic nu provine dintr-un cont; rezultatele au forma pe care le-o dă serverul, deși
raportul Strategy Tester din spatele exemplului de backtest nu a fost încă citit din aplicația reală.

**„Ce văd pe grafic? Spune-mi simbolul, intervalul de timp și ce indicatori sunt pe el.”** Asistentul
citește graficul cu `chart_get_state`
([detalii](../examples.md#1-read-the-chart)):

```json
"symbol": "NASDAQ:AAPL",
"resolution": "1D",
"chartTypeName": "candles",
```

**„Arată-mi ultimele 3 lumânări zilnice.”** Citește barele cu `data_get_ohlcv`
([detalii](../examples.md#3-read-the-last-candles)):

```json
"timeIso": "2024-10-27T00:00:00Z",
"open": 103.58,
"close": 103.42,
```

**„Adaugă MACD pe graficul meu.”** Pe un grafic care are deja atâția indicatori câți permite planul,
`indicator_add` nu adaugă nimic și raportează limita, iar eliminarea unuia dintre indicatorii tăi
pentru a face loc necesită confirmarea ta ([detalii](../examples.md#5-add-an-indicator-to-a-full-chart)):

```json
"code": "PLAN_LIMIT",
"message": "The chart holds as many indicators as the plan allows (2)",
```

**„Scrie un indicator Pine Script care trasează o medie mobilă pe 9 bare și una pe 21 de bare ale
prețului de închidere și verifică dacă se compilează.”** Pune scriptul în Pine Editor cu `pine_new`
și îl compilează cu `pine_compile` ([detalii](../examples.md#6-write-and-compile-a-pine-script)):

```json
"success": true,
"errors": [],
"warnings": [],
```

**„Scriptul din Pine Editor nu se compilează. Îl poți repara?”** `pine_smart_compile` compilează
scriptul, aplică corecturi bazate pe reguli pentru erorile pe care le cunoaște, cum ar fi nume din
Pine v4 într-un script v6, și compilează din nou, fără să modifice editorul
([detalii](../examples.md#7-fix-a-pine-script-with-smart-compile)):

```json
"message": "Could not find function or function reference 'study'",
…
"applied": ["Replace study( with indicator(", "Replace rsi( with ta.rsi("]
…
"writtenBack": false
```

**„Cum s-a descurcat în backtest strategia de pe graficul meu?”** Citește Strategy Tester cu
`strategy_get_results` și `strategy_get_trades`
([detalii](../examples.md#8-read-backtest-results)):

```json
"netProfit": 155,
"totalTrades": 3,
"percentProfitable": 66.67,
"profitFactor": 4.1,
```

**„Trasează o linie de suport la 102.80 pe graficul meu.”** Desenează o linie orizontală cu
`drawing_create`, iar `drawing_list` o afișează lângă propriile tale desene, marcată ca desenată de
această sesiune ([detalii](../examples.md#9-draw-a-support-line)):

```json
"id": "DRW001",
"shape": "horizontal_line",
"text": "Support",
"createdByServer": true
```

**„Anunță-mă când Apple trece de 110.”** `alert_create` setează o alertă de preț în contul tău
TradingView ([detalii](../examples.md#10-create-a-price-alert)). Când planul are deja atâtea alerte
câte permite, nu creează nimic și raportează limita, iar `alert_list` afișează alertele care îl
ocupă ([detalii](../examples.md#11-create-an-alert-when-the-plan-is-full)):

```json
"symbol": "NASDAQ:AAPL",
"condition": "crossing",
"price": 110,
"expirationIso": "2024-11-26T00:00:00Z"
```

**„Adaugă aceste simboluri în watchlist-ul meu: NYSE:IBM, FX:EURUSD, NASDAQ:MSFT și NASDAQ:MSTF.”**
`watchlist_add_bulk` verifică fiecare simbol cu căutarea de simboluri din TradingView, le adaugă pe
cele noi și spune de ce le-a sărit pe celelalte ([detalii](../examples.md#12-add-symbols-to-a-watchlist)):

```json
"added": ["NYSE:IBM", "FX:EURUSD"],
…
{ "symbol": "NASDAQ:MSFT", "reason": "already_listed" },
{ "symbol": "NASDAQ:MSTF", "reason": "unknown" }
```

**„Vreau să exersez cu un bar replay al graficului meu începând din 2024-06-03: avansează cinci
bare, spune-mi unde suntem, apoi încheie replay-ul.”** Pornește bar replay cu `replay_start`,
avansează cu `replay_step`, citește unde se află replay-ul cu `replay_status` și îl închide cu
`replay_stop`. Nu se tranzacționează nimic: nicio unealtă nu plasează ordine
([detalii](../examples.md#13-practice-with-bar-replay)):

```json
"dateIso": "2024-06-07T00:00:00Z",
"stepped": 5,
…
"position": null,
"realizedPL": null
```

**„Fă o captură de ecran a graficului meu.”** `screenshot_capture` îi transmite asistentului
imaginea ca imagine, împreună cu dimensiunea ei, și nu scrie nimic pe disc
([detalii](../examples.md#14-take-a-screenshot)):

```json
"data": { "target": "chart", "format": "jpeg", "width": 1180, "height": 640, "bytes": 3100 },
"meta": { "via": "cdp", "warnings": [] }
```

Serverul oferă și cinci prompturi proprii, pe care un client care suportă prompturi MCP le listează
ca să alegi dintre ele: `analyze_current_chart`, `multi_timeframe_review`,
`write_and_backtest_strategy`, `debug_pine_script` și `replay_practice_session`. Fiecare îi spune
asistentului ce unelte să apeleze, în ce ordine și ce să raporteze. `replay_practice_session`
rulează o sesiune de exersare în bar replay: asistentul parcurge trecutul bară cu bară, te întreabă
la fiecare pas dacă ai intra long, short sau ai rămâne flat, ține un jurnal al acestor tranzacții
ipotetice la prețuri pe care le citește de pe grafic și calculează profitul sau pierderea lor.
Verifică mai întâi dacă rulează un replay al tău și te întreabă ce să facă cu el înainte să schimbe
ceva; la final oprește replay-ul pe care l-a pornit el și niciodată unul de-al tău.

### <a id="safety"></a>Siguranță

Uneltele care îți modifică graficul, scripturile sau contul sunt atente cu ce este deja al tău.
Înlocuirea textului nesalvat din Pine Editor (în afară de o editare nesalvată făcută chiar de
această sesiune a serverului), salvarea unei versiuni noi a unui script pe care această sesiune nu
l-a creat și eliminarea unui indicator care era deja pe grafic necesită toate `confirm: true`, pe
care asistentul ar trebui să îl transmită doar după ce ești de acord. La fel și eliminarea unui
desen, a unei alerte, a unui simbol din watchlist sau a unei file pe care această sesiune nu le-a
creat, adăugat sau deschis, eliminarea tuturor desenelor unui grafic, trecerea de la un layout cu
modificări nesalvate și schimbarea pe un layout multi-chart cu mai puține grafice decât arată fila,
a cărui următoare salvare le-ar elimina pe celelalte. O limită a planului, cum ar fi numărul de
indicatori de pe un grafic, de scripturi salvate, de alerte sau de grafice dintr-un layout, este
verificată înainte să se adauge ceva și este raportată ca eroare `PLAN_LIMIT` împreună cu limita;
când limita nu poate fi citită în build-ul tău de TradingView, unealta nu face nimic și spune asta.
Serverul nu ocolește nicio limită. Uneltele verifică mai întâi ce ar face TradingView să deschidă
dialogul de upgrade sau un alt dialog propriu și refuză în schimb, dar rămân câteva prompturi pe care
aceste verificări nu le pot anticipa: `layout_switch` poate întâlni un prompt de upgrade pentru un
layout multi-chart salvat pe un plan cu mai puține grafice, pentru un layout pe care serverul
TradingView îl refuză ca depășind limita și pentru unul pe care lista internă a TradingView îl
marchează ca depășind limita, în timp ce `layout_list` nu; `layout_new` poate întâlni un mesaj al
TradingView când acesta refuză noul layout după verificări; iar `tab_close` poate întâlni dialogul
„Close tab?” pentru o pagină căreia îi ia mai mult decât așteaptă TradingView să spună dacă
layout-ul ei are modificări nesalvate, sau care raportează o înregistrare în curs. Uneltele de nivel
scăzut `ui_*` dau clic și tastează ce le ceri, așa că pot deschide, prin design, dialoguri ale
TradingView. Serverul nu șterge și nu redenumește niciun script.

Nicio unealtă nu plasează ordine: bar replay este pentru exersare, iar asistentul păstrează orice
tranzacții de exersare în conversație. Capturile de ecran ajung la client ca imagini, iar serverul
nu scrie niciuna pe disc. `ui_evaluate`, care rulează JavaScript în pagina graficului, este
dezactivat dacă nu pornești serverul cu `--allow-eval` (`TV_MCP_ALLOW_EVAL=true`).

### <a id="tool-profiles"></a>Profiluri de unelte

Implicit, serverul oferă toate cele 83 de unelte ale sale (`--profile full`). Unii clienți acceptă
doar un număr limitat de unelte (Cursor avertizează peste 40). Pentru ei, `--profile core` oferă un
set redus de 40 de unelte esențiale, iar `--profile readonly` oferă doar cele 37 de unelte care
citesc. `--tools` acceptă tipare de nume precum `chart_*,data_*` și restrânge și mai mult profilul:
o unealtă trebuie să fie în profil și să se potrivească unui tipar, așa că
`--profile core --tools 'pine_*'` tot lasă pe dinafară `pine_open` și `pine_save`, care nu sunt
unelte core; cu profilul implicit, `--tools` singur alege uneltele. Unele descrieri și indicii
menționează unelte pe care `core` le lasă pe dinafară, cum ar fi `pine_open` și `pine_save`, pe care
asistentul nu le poate apela sub `core`. Resursele urmează uneltele: fiecare este oferită doar
împreună cu unealta cu care își împarte datele, cum ar fi `tradingview://pine/source` cu
`pine_get_source`, așa că `--tools 'chart_*'` oferă starea graficului și nimic din Pine Editor.

[Referința uneltelor](../tools.md) listează fiecare unealtă cu parametrii ei și profilurile din care
face parte.

## <a id="troubleshooting"></a>Depanare

[docs/troubleshooting.md](../troubleshooting.md) explică fiecare cod de eroare și ce să faci când
TradingView nu este găsit, portul de depanare este ocupat, un client nu afișează uneltele sau un
tunel refuză o cerere. `npx -y tradingview-desktop-mcp doctor` este primul lucru pe care să îl rulezi.

## <a id="dashboard"></a>Dashboard

Serverul vine cu un dashboard web pentru a urmări ce face asistentul tău și pentru a încerca manual
o unealtă. Nu necesită nicio instalare suplimentară: pachetul publicat îl include, iar `pnpm build`
îl compilează în serverul unei copii locale.

![Pagina de stare: TradingView accesibil, cu un grafic găsit și aplicația pregătită, informațiile despre server și limitele planului](../images/dashboard-status.png)

### <a id="open-it"></a>Cum îl deschizi

- **Transport HTTP:** pornește serverul cu un token și deschide `http://127.0.0.1:8787/`.
  Dashboard-ul este activ implicit în acest mod; `--no-dashboard` (`TV_MCP_DASHBOARD=false`) îl
  dezactivează.

  ```sh
  TV_MCP_AUTH_TOKEN="$(openssl rand -hex 32)" npx -y tradingview-desktop-mcp --transport http
  ```

  Dintr-o copie locală, rulează în schimb `node packages/server/dist/cli.js --transport http`.

- **Alături de stdio:** un client MCP care pornește serverul prin stdio poate avea și el un
  dashboard. Adaugă `--dashboard` (`TV_MCP_DASHBOARD=true`) și `TV_MCP_AUTH_TOKEN` în configurația
  lui. Dashboard-ul ascultă pe propria adresă, `127.0.0.1:8787` dacă nu setezi `--host` și `--port`,
  și nu servește `/mcp`. Fără token sau când portul este ocupat, dashboard-ul rămâne dezactivat și
  serverul scrie un avertisment în log, dar serverul MCP continuă să ruleze. Apelurile făcute de
  client apar în logul în timp real.

Serverul afișează adresa dashboard-ului pe stderr când pornește. Nu afișează niciodată tokenul.

### <a id="the-token"></a>Tokenul

Pagina cere tokenul (`TV_MCP_AUTH_TOKEN`) înainte să afișeze ceva. Lipește-l sau deschide o singură
dată `http://127.0.0.1:8787/#token=<token>`: pagina citește tokenul din fragment și îl elimină din
adresă, iar fragmentul nu este trimis niciodată la server. Pagina păstrează tokenul în
`sessionStorage`, așa că dispare când închizi fila, și trimite tokenul doar ca
`Authorization: Bearer <token>`, niciodată într-un URL. Când serverul repornește cu alt token,
pagina îl cere din nou. Vezi [SECURITY.md](../../SECURITY.md#the-dashboard).

### <a id="what-it-shows"></a>Ce afișează

![Logul în timp real: un tabel cu apelurile de unelte, cele mai noi primele, cu ora, unealta, originea, starea și durata lor, iar deasupra căutarea și filtrele](../images/dashboard-log.png)

- **Status** arată dacă TradingView este accesibil (și cum să îl pornești când nu este), cum rulează
  serverul, limitele planului și cele mai recente apeluri.
- **Log** transmite în flux fiecare apel de unealtă pe care îl rulează serverul, fie că l-a făcut un
  client MCP, fie dashboard-ul, cu filtru după numele uneltei, pauză, golire și detaliile fiecărui
  apel. După o conexiune întreruptă afișează „Reconnecting…” și continuă de unde a rămas. Fiecare
  filă deschisă a dashboard-ului păstrează un flux de evenimente către server, iar un browser permite
  în jur de șase conexiuni către același host, așa că, având multe file de dashboard deschise, una
  nouă poate aștepta o conexiune liberă: închide filele pe care nu le folosești.
- **Tools** listează uneltele oferite de server, cu parametrii lor, și rulează manual una dintre ele.
  Rezultatul este afișat exact cum a venit, cu JSON-ul lung restrâns în spatele butonului „Show all”
  și imaginile ca imagini.

![Pagina de unelte: lista de unelte cu căutarea și filtrele ei în stânga și chart_get_state cu descrierea, informațiile și câmpurile de intrare în dreapta](../images/dashboard-tools.png)

O rulare din dashboard este un apel real de unealtă. Trece prin același registru ca un apel MCP,
așa că se aplică aceleași scheme, același profil, aceleași reguli `confirm` și aceleași verificări
ale limitelor planului, iar apelul apare în log. Dashboard-ul îți cere confirmarea înainte să ruleze
orice unealtă care nu este read-only.

### <a id="the-api"></a>API-ul

Pagina comunică cu serverul printr-un API mic, pe care îl poți apela și tu cu `curl` și tokenul.
Fiecare rută necesită `Authorization: Bearer <token>`, iar serverul verifică `Host` și `Origin` la
fel ca pentru `/mcp`.

| Rută                     | Ce face                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| `GET /api/info`          | Versiunea, transportul, profilul, numărul de unelte și ora pornirii                       |
| `GET /api/health`        | Raportul de stare: dacă TradingView este accesibil                                        |
| `GET /api/tools`         | Uneltele oferite, cu schemele și adnotările lor                                           |
| `POST /api/tools/<name>` | Rulează o unealtă cu `{"arguments": {...}}`, cu originea `dashboard`                      |
| `GET /api/events`        | Server-sent events ale apelurilor de unelte; `?limit=` setează câte să fie redate din nou |

Fișierele paginii în sine, la `/`, nu necesită token și nu conțin date.

## <a id="contributing"></a>Contribuții

Vezi [CONTRIBUTING.md](../../CONTRIBUTING.md) pentru configurarea locală, nivelurile de testare,
convențiile pentru commituri și modul în care se face o versiune nouă, și
[docs/testing.md](../testing.md) pentru ghidul de testare. Pentru a raporta o vulnerabilitate,
urmează [SECURITY.md](../../SECURITY.md).

## <a id="disclaimer"></a>Declinarea responsabilității

Acest proiect nu este afiliat cu TradingView, Inc., nu este aprobat și nici sponsorizat de aceasta.
TradingView este o marcă comercială a proprietarului său. Nimic de aici nu constituie consiliere
financiară. Uneltele modifică ce afișează aplicația și pot ajunge la controalele ei, așa că tu ești
responsabil pentru ce automatizezi și pentru respectarea termenilor de utilizare ai TradingView.

## <a id="license"></a>Licență

Publicat sub [licența MIT](../../LICENSE).
