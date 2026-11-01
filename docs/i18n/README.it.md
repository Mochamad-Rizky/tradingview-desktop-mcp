# tradingview-desktop-mcp

[English](../../README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Türkçe](README.tr.md) · [Русский](README.ru.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Українська](README.uk.md) · [Polski](README.pl.md) · [Português (Brasil)](README.pt-BR.md) · [العربية](README.ar.md) · [فارسی](README.fa.md) · [Bahasa Indonesia](README.id.md) · **Italiano** · [Ελληνικά](README.el.md) · [മലയാളം](README.ml.md) · [Roman Urdu](README.ur-Latn.md) · [Română](README.ro.md)

[![npm](https://img.shields.io/npm/v/tradingview-desktop-mcp)](https://www.npmjs.com/package/tradingview-desktop-mcp)
[![CI](https://github.com/Mochamad-Rizky/tradingview-desktop-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Mochamad-Rizky/tradingview-desktop-mcp/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/Mochamad-Rizky/tradingview-desktop-mcp/graph/badge.svg)](https://codecov.io/gh/Mochamad-Rizky/tradingview-desktop-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../../LICENSE)

> Questa è una traduzione del [README in inglese](../../README.md). Se le due versioni differiscono, fa fede la versione inglese.

<p align="center">
  <a href="../media/promo.mp4"><img src="../media/teaser.gif" width="49%" alt="Il video di presentazione: un assistente legge un grafico, traccia una linea di supporto, scrive uno script Pine Script e imposta un alert di prezzo"></a>
  <a href="../media/tutorial.mp4"><img src="../media/tutorial-poster.jpg" width="49%" alt="Il tutorial di configurazione: tutto pronto in cinque passaggi"></a>
</p>

<p align="center">
  <a href="../media/promo.mp4"><b>▶ Guarda la presentazione</b></a> (0:48) &nbsp;·&nbsp;
  <a href="../media/tutorial.mp4"><b>▶ Guarda il tutorial di configurazione</b></a> (1:53)<br>
  <sub>Entrambi i video usano un grafico inventato, non dati di mercato.</sub>
</p>

Un server [MCP](https://modelcontextprotocol.io) che permette agli assistenti AI di leggere e
controllare l'app TradingView Desktop sul tuo computer. Pilota l'app in cui hai già effettuato
l'accesso tramite il Chrome DevTools Protocol, attraverso la porta di debug che l'app apre quando
viene avviata con `--remote-debugging-port`. Automatizza soltanto l'app locale: non effettua
l'accesso al posto tuo, non aggira i limiti del piano e non chiama i server di TradingView.

> **Stato: pre-1.0.** Nomi degli strumenti e opzioni possono cambiare prima della 1.0. Installa il
> pacchetto da npm, come descritto sotto, oppure esegui il server [dai sorgenti](#quick-start-from-source).
> È stato provato su macOS; Windows e Linux sono supportati al meglio delle possibilità.

Il server offre strumenti per l'app (avvio, stato di salute, rilevamento, stato dell'interfaccia,
limiti del piano, riconnessione), strumenti per il grafico (stato, simbolo, timeframe, tipo di
grafico, intervallo visibile, scorrimento), strumenti per i dati di mercato (barre, quotazioni,
informazioni e ricerca dei simboli), strumenti per gli indicatori (elenco, ricerca, aggiunta,
rimozione, input, visibilità, valori), strumenti per Pine Script (l'editor e gli script salvati,
compilazione, compilazione intelligente con correzioni basate su regole, analisi offline, la console
e le linee, etichette, riquadri e tabelle che gli script disegnano), strumenti per lo Strategy Tester
(risultati, operazioni, equity), strumenti per disegni, alert e watchlist, strumenti per layout,
multi-grafico e schede, bar replay, screenshot, strumenti di interfaccia a basso livello (clic,
hover, digitazione, tasti, scorrimento, ricerca, pannelli, schermo intero e JavaScript nella pagina
del grafico, se lo consenti) e `batch_run`, che esegue più strumenti in un'unica chiamata. Offre
anche risorse (lo stato di salute dell'app, lo stato e le barre del grafico, il sorgente Pine e
l'ultimo risultato di compilazione, il report della strategia, la watchlist attiva), ciascuna insieme
allo strumento con cui condivide i dati, e cinque prompt per le attività più comuni. Una dashboard
web mostra le chiamate in tempo reale ed esegue gli strumenti a mano (vedi [Dashboard](#dashboard)).

Indice: [Installazione chiedendo alla tua app AI](#install-by-asking-your-ai-app), [Installazione](#install),
[Collega la tua app AI](#connect-your-ai-app), [Client remoti e tunnel](#remote-clients-and-tunnels),
[Avvio rapido dai sorgenti](#quick-start-from-source), [Utilizzo](#use-it),
[Risoluzione dei problemi](#troubleshooting), [Dashboard](#dashboard), [Contribuire](#contributing).

## <a id="install-by-asking-your-ai-app"></a>Installazione chiedendo alla tua app AI

Non devi digitare nessun comando. Se la tua app AI può eseguire comandi sul tuo computer, come
Claude Code, Cursor, VS Code, Windsurf, Gemini CLI e Codex CLI, può occuparsi della configurazione
al posto tuo. Prima di tutto:

1. Installa [TradingView Desktop](https://www.tradingview.com/desktop/) ed effettua l'accesso.
2. Installa [Node.js](https://nodejs.org) (la versione LTS), se non l'hai ancora.

Poi copia questo prompt, incollalo nella tua app AI e invialo:

```text
Installa per me il server TradingView MCP. È il pacchetto npm tradingview-desktop-mcp
(https://github.com/Mochamad-Rizky/tradingview-desktop-mcp). Segui questi passaggi e spiegami ognuno
di essi con parole semplici:

1. Verifica che sia installato Node.js 20.19 o successivo. Se non lo è, fermati e spiegami come installarlo.
2. Esegui "npx -y tradingview-desktop-mcp config <client>", dove <client> è l'app in cui stai
   girando (claude-code, cursor, vscode, windsurf, gemini-cli o codex-cli). Fai quello che stampa
   per aggiungere il server alla mia configurazione, e mantieni tutti gli altri server già presenti.
3. Avvia TradingView con "npx -y tradingview-desktop-mcp launch". Se dice che TradingView è già in
   esecuzione senza la porta di debug, chiedimelo prima e, solo se sono d'accordo, eseguilo di nuovo
   con --restart, perché così TradingView viene chiuso e potrei perdere modifiche non salvate.
4. Esegui "npx -y tradingview-desktop-mcp doctor" e dimmi se tutti i controlli passano. Se il
   controllo del grafico fallisce, dimmi di portare in primo piano la scheda del grafico in TradingView.
5. Dimmi se devo riavviarti, o aprire una nuova chat, prima che compaiano gli strumenti di TradingView.
```

Quando ha finito, riavvia l'app o apri una nuova chat se te lo ha detto, e chiedi "Verifica che
TradingView sia collegato." Poi prova i [prompt qui sotto](#try-these-prompts).

Usi Claude Desktop? Non può eseguire comandi, ma Claude Code, Cursor e le altre app citate sopra
possono configurarlo per te: aggiungi "Configuralo per Claude Desktop (config claude-desktop), non
per questa app." alla fine del prompt. ChatGPT e OpenAI API richiedono un tunnel, che va configurato
a mano (vedi [Client remoti e tunnel](#remote-clients-and-tunnels)). Se l'assistente si blocca, segui
tu stesso i passaggi qui sotto.

## <a id="install"></a>Installazione

Ti servono:

- TradingView Desktop, installato e con l'accesso effettuato.
- Node.js 20.19 o successivo, che fornisce `npx`.

Non viene installato nient'altro: i client qui sotto avviano il server con
`npx -y tradingview-desktop-mcp`, che scarica il pacchetto al primo utilizzo. Avvia TradingView con
la sua porta di debug. Il comando `launch` trova l'app e la avvia in questo modo:

```sh
npx -y tradingview-desktop-mcp launch
```

TradingView consente una sola istanza. Se è già in esecuzione senza la porta di debug, `launch` si
ferma e lo segnala; `launch --restart` la chiude in modo pulito e la riavvia con la porta, e
TradingView potrebbe chiederti prima di salvare le modifiche. Verifica che il server riesca a
raggiungere l'app:

```sh
npx -y tradingview-desktop-mcp doctor
```

`doctor` non supera il controllo del grafico finché la scheda del grafico è in secondo piano, dietro
la pagina Nuova scheda o un'altra scheda senza grafico, quindi porta in primo piano la scheda del
grafico.
`npx -y tradingview-desktop-mcp --help` elenca le opzioni, e [.env.example](../../.env.example) le
variabili d'ambiente.

## <a id="connect-your-ai-app"></a>Collega la tua app AI

`config <client>` stampa lo snippet di configurazione di un client e indica dove inserirlo. Ciascuno
dei tutorial qui sotto contiene lo stesso snippet, i passaggi per quell'app e cosa fare quando non
funziona.

| Client                                         | Stampa lo snippet                                      |
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

Il trasporto predefinito è stdio, in cui stdout trasporta solo messaggi MCP e i log vanno su stderr.
I primi sette client avviano il server da soli. Su Windows, un client che non riesce ad avviare
`npx` direttamente ha bisogno della forma `cmd /c npx`, che `config` stampa quando gira su Windows
(o con `--platform win32`). `--profile` passa al server un [profilo di strumenti](#tool-profiles).

### <a id="remote-clients-and-tunnels"></a>Client remoti e tunnel

ChatGPT e OpenAI API non possono avviare un programma sul tuo computer. Raggiungono il server a un
indirizzo HTTPS pubblico, quindi lo esegui via HTTP e ci metti davanti un tunnel. In questo modo
esponi su internet un server in grado di controllare il tuo TradingView con l'accesso effettuato:
usa `--profile readonly`, un token robusto (`TV_MCP_AUTH_TOKEN`), l'host pubblico del tunnel in
`--allowed-hosts` (`TV_MCP_ALLOWED_HOSTS`) e `--no-dashboard`, così che i file della dashboard non
vengano serviti attraverso il tunnel. I tutorial per [ChatGPT](../clients/chatgpt.md) e per
[OpenAI API](../clients/openai-api.md) ti guidano passo per passo, e
[SECURITY.md](../../SECURITY.md#tunnels-and-remote-clients) elenca cosa può ancora raggiungere un token di
sola lettura.

## <a id="quick-start-from-source"></a>Avvio rapido dai sorgenti

Per eseguire un checkout invece del pacchetto pubblicato, ti servono Node.js 24 per compilare il
server (`nvm use` legge `.nvmrc`) e [pnpm](https://pnpm.io), nella versione fissata in
`package.json`. Il server compilato gira su Node.js 20.19 o successivo.

```sh
git clone https://github.com/Mochamad-Rizky/tradingview-desktop-mcp.git
cd tradingview-desktop-mcp
pnpm install && pnpm build
node packages/server/dist/cli.js launch
node packages/server/dist/cli.js doctor
```

`node packages/server/dist/cli.js config <client> --local` stampa lo snippet di un client per questo
checkout, con `node` e il percorso assoluto di `cli.js` al posto di `npx`. Per un client con
configurazione in JSON, la voce è fatta così:

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

Esiste anche un trasporto HTTP (`--transport http`); leggi [SECURITY.md](../../SECURITY.md) prima di
usarlo.

## <a id="use-it"></a>Utilizzo

Collega un client MCP come descritto sopra, con TradingView in esecuzione con la sua porta di debug,
e chiedi quello che ti serve con parole semplici. L'assistente sceglie gli strumenti e li chiama,
quindi non devi conoscerne i nomi. Il [riferimento degli strumenti](../tools.md) elenca ogni
strumento con i suoi input e i profili a cui appartiene.

### <a id="try-these-prompts"></a>Prova questi prompt

Ogni prompt qui sotto è uno degli esempi in [docs/examples.md](../examples.md), che mostra le
chiamate agli strumenti fatte dall'assistente e i risultati, con gli elenchi di più di tre elementi
tagliati, la durata di ogni chiamata (`durationMs`) omessa e lo screenshot citato in una nota invece
che mostrato. Gli estratti sono righe di quei risultati, e `…` indica dove sono state omesse righe di
altre parti di un risultato. I valori sono sintetici: provengono da una finta app TradingView con un
grafico NASDAQ:AAPL inventato, quindi nulla è un dato di mercato e nulla proviene da un account; i
risultati hanno la forma che il server dà loro, anche se il report dello Strategy Tester alla base
dell'esempio di backtest non è ancora stato letto dall'app reale.

**"Cosa sto guardando sul mio grafico? Dimmi il simbolo, il timeframe e quali indicatori ci sono."**
L'assistente legge il grafico con `chart_get_state`
([dettagli](../examples.md#1-read-the-chart)):

```json
"symbol": "NASDAQ:AAPL",
"resolution": "1D",
"chartTypeName": "candles",
```

**"Mostrami le ultime 3 candele giornaliere."** Legge le barre con `data_get_ohlcv`
([dettagli](../examples.md#3-read-the-last-candles)):

```json
"timeIso": "2024-10-27T00:00:00Z",
"open": 103.58,
"close": 103.42,
```

**"Aggiungi il MACD al mio grafico."** Su un grafico che contiene già tanti indicatori quanti ne
consente il piano, `indicator_add` non aggiunge nulla e segnala il limite, e rimuovere uno dei tuoi
indicatori per fare spazio richiede la tua conferma
([dettagli](../examples.md#5-add-an-indicator-to-a-full-chart)):

```json
"code": "PLAN_LIMIT",
"message": "The chart holds as many indicators as the plan allows (2)",
```

**"Scrivi un indicatore in Pine Script che tracci una media mobile a 9 barre e una a 21 barre della
chiusura, e verifica che compili."** Mette lo script nel Pine Editor con `pine_new` e lo compila con
`pine_compile` ([dettagli](../examples.md#6-write-and-compile-a-pine-script)):

```json
"success": true,
"errors": [],
"warnings": [],
```

**"Lo script nel mio Pine Editor non compila. Puoi sistemarlo?"** `pine_smart_compile` compila lo
script, applica correzioni basate su regole per gli errori che conosce, come i nomi di Pine v4 in
uno script v6, e compila di nuovo, senza modificare l'editor
([dettagli](../examples.md#7-fix-a-pine-script-with-smart-compile)):

```json
"message": "Could not find function or function reference 'study'",
…
"applied": ["Replace study( with indicator(", "Replace rsi( with ta.rsi("]
…
"writtenBack": false
```

**"Come è andata nel backtest la strategia sul mio grafico?"** Legge lo Strategy Tester con
`strategy_get_results` e `strategy_get_trades`
([dettagli](../examples.md#8-read-backtest-results)):

```json
"netProfit": 155,
"totalTrades": 3,
"percentProfitable": 66.67,
"profitFactor": 4.1,
```

**"Traccia una linea di supporto a 102.80 sul mio grafico."** Disegna una linea orizzontale con
`drawing_create`, e `drawing_list` la mostra accanto ai tuoi disegni, contrassegnata come disegnata
da questa sessione ([dettagli](../examples.md#9-draw-a-support-line)):

```json
"id": "DRW001",
"shape": "horizontal_line",
"text": "Support",
"createdByServer": true
```

**"Avvisami quando Apple incrocia 110."** `alert_create` imposta un alert di prezzo nel tuo account
TradingView ([dettagli](../examples.md#10-create-a-price-alert)). Quando il piano contiene già
tanti alert quanti ne consente, non crea nulla e segnala il limite, e `alert_list` mostra gli alert
che lo occupano ([dettagli](../examples.md#11-create-an-alert-when-the-plan-is-full)):

```json
"symbol": "NASDAQ:AAPL",
"condition": "crossing",
"price": 110,
"expirationIso": "2024-11-26T00:00:00Z"
```

**"Aggiungi questi simboli alla mia watchlist: NYSE:IBM, FX:EURUSD, NASDAQ:MSFT e NASDAQ:MSTF."**
`watchlist_add_bulk` verifica ogni simbolo con la ricerca simboli di TradingView, aggiunge quelli
nuovi e spiega perché ha saltato gli altri
([dettagli](../examples.md#12-add-symbols-to-a-watchlist)):

```json
"added": ["NYSE:IBM", "FX:EURUSD"],
…
{ "symbol": "NASDAQ:MSFT", "reason": "already_listed" },
{ "symbol": "NASDAQ:MSTF", "reason": "unknown" }
```

**"Fammi esercitare con un bar replay del mio grafico a partire dal 2024-06-03: vai avanti di cinque
barre, dimmi dove siamo, poi termina il replay."** Avvia il bar replay con `replay_start`, avanza con
`replay_step`, legge a che punto è il replay con `replay_status` e ne esce con `replay_stop`. Non
viene negoziato nulla: nessuno strumento invia ordini
([dettagli](../examples.md#13-practice-with-bar-replay)):

```json
"dateIso": "2024-06-07T00:00:00Z",
"stepped": 5,
…
"position": null,
"realizedPL": null
```

**"Fai uno screenshot del mio grafico."** `screenshot_capture` passa la schermata all'assistente come
immagine, insieme alle sue dimensioni, e non scrive nulla su disco
([dettagli](../examples.md#14-take-a-screenshot)):

```json
"data": { "target": "chart", "format": "jpeg", "width": 1180, "height": 640, "bytes": 3100 },
"meta": { "via": "cdp", "warnings": [] }
```

Il server offre anche cinque prompt propri, che un client con supporto ai prompt MCP elenca perché tu
possa sceglierli: `analyze_current_chart`, `multi_timeframe_review`, `write_and_backtest_strategy`,
`debug_pine_script` e `replay_practice_session`. Ognuno dice all'assistente quali strumenti chiamare,
in quale ordine e cosa riferire. `replay_practice_session` conduce una sessione di pratica con il bar
replay: l'assistente ripercorre il passato barra per barra, a ogni passo ti chiede se andresti long,
short o resteresti flat, tiene un diario di queste operazioni ipotetiche ai prezzi che legge dal
grafico e ne calcola il profitto o la perdita. Prima controlla se è in corso un tuo replay, e ti
chiede cosa farne prima di modificare qualsiasi cosa; alla fine ferma il replay che ha avviato lui,
e mai uno dei tuoi.

### <a id="safety"></a>Sicurezza

Gli strumenti che modificano il tuo grafico, i tuoi script o il tuo account trattano con cautela ciò
che è già tuo. Sostituire testo non salvato nel Pine Editor (diverso da una modifica non salvata
fatta lì da questa stessa sessione del server), salvare una nuova versione di uno script che questa
sessione non ha creato e rimuovere un indicatore che era già sul tuo grafico richiedono tutti
`confirm: true`, che l'assistente dovrebbe passare solo dopo il tuo consenso. Lo stesso vale per
rimuovere un disegno, un alert, un simbolo della watchlist o una scheda che questa sessione non ha
creato, aggiunto o aperto, rimuovere tutti i disegni di un grafico, abbandonare un layout con
modifiche non salvate e passare a un layout multi-grafico con meno grafici di quelli mostrati dalla
scheda, il cui salvataggio successivo eliminerebbe gli altri. Un limite del piano, come il numero di
indicatori su un grafico, di script salvati, di alert o di grafici in un layout, viene verificato
prima di aggiungere qualsiasi cosa e segnalato come errore `PLAN_LIMIT` con il limite; quando il
limite non può essere letto sulla tua build di TradingView, lo strumento non fa nulla e lo segnala.
Il server non aggira alcun limite. Gli strumenti controllano prima cosa farebbe aprire a TradingView
la finestra di upgrade, o un'altra sua finestra di dialogo, e invece rifiutano, ma restano alcune
richieste che questi controlli non possono prevedere:
`layout_switch` può incontrare una richiesta di upgrade per un layout multi-grafico salvato su un
piano con meno grafici, per un layout che il server di TradingView rifiuta perché oltre il limite, e
per uno che l'elenco che TradingView tiene per sé segna come oltre il limite mentre `layout_list` no;
`layout_new` può incontrare un messaggio di TradingView quando rifiuta il nuovo layout dopo i
controlli; e `tab_close` può incontrare la finestra "Close tab?" per una pagina che impiega più tempo
di quanto TradingView attenda per dire se il suo layout ha modifiche non salvate, o che segnala una
registrazione in corso. Gli strumenti di basso livello `ui_*` cliccano e digitano ciò che chiedi,
quindi per loro natura possono aprire finestre di dialogo di TradingView. Il server non elimina né
rinomina alcuno script.

Nessuno strumento invia ordini: il bar replay serve per esercitarsi, e l'assistente tiene le
eventuali operazioni di prova nella conversazione. Gli screenshot arrivano al client come immagini,
e il server non ne scrive nessuno su disco. `ui_evaluate`, che esegue JavaScript nella pagina del
grafico, è disattivato a meno che tu non avvii il server con `--allow-eval`
(`TV_MCP_ALLOW_EVAL=true`).

### <a id="tool-profiles"></a>Profili di strumenti

Per impostazione predefinita il server offre tutti i suoi 83 strumenti (`--profile full`). Alcuni
client accettano solo un numero limitato di strumenti (Cursor avvisa sopra i 40). Per loro,
`--profile core` offre un insieme ridotto di 40 strumenti essenziali, e `--profile readonly` offre
solo i 37 strumenti che leggono. `--tools` accetta pattern di nomi come `chart_*,data_*` e restringe
ulteriormente il profilo: uno strumento deve far parte del profilo e corrispondere a un pattern,
quindi `--profile core --tools 'pine_*'` esclude comunque `pine_open` e `pine_save`, che non sono
strumenti core; con il profilo predefinito, `--tools` da solo sceglie gli strumenti. Alcune
descrizioni e suggerimenti nominano strumenti che `core` esclude, come `pine_open` e `pine_save`,
che l'assistente non può chiamare con `core`. Le risorse seguono gli strumenti: ciascuna viene
offerta solo insieme allo strumento con cui condivide i dati, come `tradingview://pine/source` con
`pine_get_source`, quindi `--tools 'chart_*'` offre lo stato del grafico e niente del Pine Editor.

Il [riferimento degli strumenti](../tools.md) elenca ogni strumento con i suoi input e i profili a
cui appartiene.

## <a id="troubleshooting"></a>Risoluzione dei problemi

[docs/troubleshooting.md](../troubleshooting.md) spiega ogni codice di errore e cosa fare quando
TradingView non viene trovato, la porta di debug è occupata, un client non mostra gli strumenti o un
tunnel rifiuta una richiesta. `npx -y tradingview-desktop-mcp doctor` è la prima cosa da eseguire.

## <a id="dashboard"></a>Dashboard

Il server include una dashboard web per osservare cosa fa il tuo assistente e per provare uno
strumento a mano. Non richiede installazioni aggiuntive: il pacchetto pubblicato la contiene già, e
`pnpm build` la compila nel server di un checkout.

![La pagina di stato: TradingView raggiungibile con un grafico trovato e l'app pronta, le informazioni sul server e i limiti del piano](../images/dashboard-status.png)

### <a id="open-it"></a>Aprirla

- **Trasporto HTTP:** avvia il server con un token e apri `http://127.0.0.1:8787/`. In questa
  modalità la dashboard è attiva per impostazione predefinita; `--no-dashboard`
  (`TV_MCP_DASHBOARD=false`) la disattiva.

  ```sh
  TV_MCP_AUTH_TOKEN="$(openssl rand -hex 32)" npx -y tradingview-desktop-mcp --transport http
  ```

  Da un checkout, esegui invece `node packages/server/dist/cli.js --transport http`.

- **Accanto a stdio:** anche un client MCP che avvia il server tramite stdio può avere una
  dashboard. Aggiungi `--dashboard` (`TV_MCP_DASHBOARD=true`) e `TV_MCP_AUTH_TOKEN` alla sua
  configurazione. La dashboard resta in ascolto su un proprio indirizzo, `127.0.0.1:8787` a meno che
  tu non imposti `--host` e `--port`, e non serve `/mcp`. Senza il token, o quando la porta è
  occupata, la dashboard resta disattivata e il server registra un avviso, ma il server MCP continua
  a funzionare. Le chiamate fatte dal client compaiono nel log in tempo reale.

All'avvio il server stampa l'indirizzo della dashboard su stderr. Non stampa mai il token.

### <a id="the-token"></a>Il token

La pagina chiede il token (`TV_MCP_AUTH_TOKEN`) prima di mostrare qualsiasi cosa. Incollalo, oppure
apri una volta `http://127.0.0.1:8787/#token=<token>`: la pagina legge il token dal frammento e lo
rimuove dall'indirizzo, e il frammento non viene mai inviato al server. La pagina conserva il token
in `sessionStorage`, quindi sparisce quando chiudi la scheda, e lo invia solo come
`Authorization: Bearer <token>`, mai in un URL. Quando il server si riavvia con un altro token, la
pagina lo chiede di nuovo. Vedi [SECURITY.md](../../SECURITY.md#the-dashboard).

### <a id="what-it-shows"></a>Cosa mostra

![Il log in tempo reale: una tabella delle chiamate agli strumenti, dalla più recente, con orario, strumento, origine, stato e durata, e sopra la ricerca e i filtri](../images/dashboard-log.png)

- **Status** mostra se TradingView è raggiungibile (e come avviarlo quando non lo è), come gira il
  server, i limiti del piano e le chiamate più recenti.
- **Log** trasmette in streaming ogni chiamata a uno strumento eseguita dal server, che l'abbia fatta
  un client MCP o la dashboard, con filtro per nome dello strumento, pausa, svuotamento e i dettagli
  di ogni chiamata. Dopo una caduta della connessione mostra "Reconnecting…" e riprende da dove si
  era interrotto. Ogni scheda aperta della dashboard mantiene uno stream di eventi verso il server, e
  un browser consente circa sei connessioni verso uno stesso host, quindi con molte schede della
  dashboard aperte una nuova può dover attendere una connessione libera: chiudi le schede che non
  usi.
- **Tools** elenca gli strumenti offerti dal server, con i loro input, e ne esegue uno a mano. Il
  risultato viene mostrato così come è tornato, con il JSON lungo compresso dietro "Show all" e le
  immagini come immagini.

![La pagina degli strumenti: l'elenco degli strumenti con ricerca e filtri a sinistra, e chart_get_state con descrizione, informazioni e campi di input a destra](../images/dashboard-tools.png)

Un'esecuzione dalla dashboard è una vera chiamata a uno strumento. Passa per lo stesso registro di
una chiamata MCP, quindi valgono gli stessi schemi, profilo, regole di `confirm` e controlli dei
limiti del piano, e compare nel log. La dashboard chiede conferma prima di eseguire qualsiasi
strumento che non sia di sola lettura.

### <a id="the-api"></a>L'API

La pagina comunica con il server tramite una piccola API, che puoi chiamare anche con `curl` e il
token. Ogni route richiede `Authorization: Bearer <token>`, e il server controlla `Host` e `Origin`
come fa per `/mcp`.

| Route                    | Cosa fa                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `GET /api/info`          | Versione, trasporto, profilo, numero di strumenti e ora di avvio                      |
| `GET /api/health`        | Il report sullo stato di salute: se TradingView è raggiungibile                       |
| `GET /api/tools`         | Gli strumenti offerti, con i loro schemi e annotazioni                                |
| `POST /api/tools/<name>` | Esegue uno strumento con `{"arguments": {...}}`, con origine `dashboard`              |
| `GET /api/events`        | Server-sent events delle chiamate agli strumenti; `?limit=` imposta quante riproporne |

I file della pagina stessa, su `/`, non richiedono token e non contengono dati.

## <a id="contributing"></a>Contribuire

Consulta [CONTRIBUTING.md](../../CONTRIBUTING.md) per la configurazione locale, i livelli di test, le
convenzioni per i commit e come viene preparata una release, e [docs/testing.md](../testing.md)
per la guida ai test. Per segnalare una vulnerabilità, segui [SECURITY.md](../../SECURITY.md).

## <a id="disclaimer"></a>Esclusione di responsabilità

Questo progetto non è affiliato, approvato o sponsorizzato da TradingView, Inc. TradingView è un
marchio del rispettivo proprietario. Nulla di quanto riportato qui costituisce consulenza
finanziaria. Gli strumenti modificano ciò che l'app mostra e possono agire sui suoi controlli, quindi
sei responsabile di ciò che automatizzi e del rispetto dei termini d'uso di TradingView.

## <a id="license"></a>Licenza

Rilasciato sotto [licenza MIT](../../LICENSE).
