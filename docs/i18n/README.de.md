# tradingview-desktop-mcp

[English](../../README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Türkçe](README.tr.md) · [Русский](README.ru.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md) · **Deutsch** · [Español](README.es.md) · [Français](README.fr.md) · [Українська](README.uk.md) · [Polski](README.pl.md) · [Português (Brasil)](README.pt-BR.md) · [العربية](README.ar.md) · [فارسی](README.fa.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Ελληνικά](README.el.md) · [മലയാളം](README.ml.md) · [Roman Urdu](README.ur-Latn.md) · [Română](README.ro.md)

[![npm](https://img.shields.io/npm/v/tradingview-desktop-mcp)](https://www.npmjs.com/package/tradingview-desktop-mcp)
[![CI](https://github.com/Mochamad-Rizky/tradingview-desktop-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Mochamad-Rizky/tradingview-desktop-mcp/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/Mochamad-Rizky/tradingview-desktop-mcp/graph/badge.svg)](https://codecov.io/gh/Mochamad-Rizky/tradingview-desktop-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../../LICENSE)

> Dies ist eine Übersetzung der [englischen README](../../README.md). Bei Abweichungen gilt die englische Fassung.

<p align="center">
  <a href="../media/promo.mp4"><img src="../media/teaser.gif" width="49%" alt="Das Übersichtsvideo: Ein Assistent liest einen Chart, zeichnet eine Unterstützungslinie, schreibt ein Pine Script und setzt einen Preisalarm"></a>
  <a href="../media/tutorial.mp4"><img src="../media/tutorial-poster.jpg" width="49%" alt="Das Einrichtungs-Tutorial: in fünf Schritten eingerichtet"></a>
</p>

<p align="center">
  <a href="../media/promo.mp4"><b>▶ Übersicht ansehen</b></a> (0:48) &nbsp;·&nbsp;
  <a href="../media/tutorial.mp4"><b>▶ Einrichtungs-Tutorial ansehen</b></a> (1:53)<br>
  <sub>Beide Videos verwenden einen erfundenen Chart, keine Marktdaten.</sub>
</p>

Ein [MCP](https://modelcontextprotocol.io)-Server, mit dem KI-Assistenten die TradingView-Desktop-App
auf deinem eigenen Rechner lesen und steuern können. Er steuert die App, in der du bereits angemeldet
bist, über das Chrome DevTools Protocol, und zwar über den Debug-Port, den die App öffnet, wenn sie
mit `--remote-debugging-port` gestartet wird. Er automatisiert nur die lokale App: Er meldet dich
nicht an, umgeht keine Tariflimits und ruft keine Server von TradingView auf.

> **Status: vor 1.0.** Toolnamen und Optionen können sich vor 1.0 noch ändern. Installiere das Paket
> wie unten beschrieben von npm, oder starte den Server [aus dem Quellcode](#quick-start-from-source).
> Getestet wurde er unter macOS; Windows und Linux werden nach bestem Bemühen unterstützt.

Der Server bietet App-Tools (Starten, Zustand, Erkennung, Zustand der Oberfläche, Tariflimits, neu
verbinden), Chart-Tools (Zustand, Symbol, Zeitrahmen, Charttyp, sichtbarer Bereich, Scrollen),
Marktdaten-Tools (Bars, Kurse, Symbolinfos und -suche), Indikator-Tools (auflisten, suchen,
hinzufügen, entfernen, Eingaben, Sichtbarkeit, Werte), Pine-Script-Tools (der Editor und gespeicherte
Skripte, Kompilieren, intelligentes Kompilieren mit regelbasierten Korrekturen, Offline-Analyse, die
Konsole sowie die Linien, Labels, Boxen und Tabellen, die Skripte zeichnen), Strategy-Tester-Tools
(Ergebnisse, Trades, Equity), Zeichen-, Alarm- und Watchlist-Tools, Layout-, Multi-Chart- und
Tab-Tools, Bar Replay, Screenshots, Low-Level-Tools für die Oberfläche (Klicken, Hovern, Tippen,
Tasten, Scrollen, Suchen, Panels, Vollbild und JavaScript in der Chart-Seite, wenn du es erlaubst)
sowie `batch_run`, das mehrere Tools in einem Aufruf ausführt. Außerdem bietet er Ressourcen (den
Zustand der App, den Chart-Zustand und die Bars, den Pine-Quellcode und das letzte
Kompilierergebnis, den Strategiebericht, die aktive Watchlist), jeweils zusammen mit dem Tool, dessen
Daten sie teilen, und fünf Prompts für häufige Aufgaben. Ein Web-Dashboard zeigt die Aufrufe live an
und führt Tools von Hand aus (siehe [Dashboard](#dashboard)).

Inhalt: [Installation per Anfrage an deine KI-App](#install-by-asking-your-ai-app), [Installation](#install),
[KI-App verbinden](#connect-your-ai-app), [Entfernte Clients und Tunnel](#remote-clients-and-tunnels),
[Schnellstart aus dem Quellcode](#quick-start-from-source), [Verwendung](#use-it),
[Fehlerbehebung](#troubleshooting), [Dashboard](#dashboard), [Mitwirken](#contributing).

## <a id="install-by-asking-your-ai-app"></a>Installation per Anfrage an deine KI-App

Du musst selbst keinen einzigen Befehl eintippen. Wenn deine KI-App Befehle auf deinem Computer
ausführen kann, wie Claude Code, Cursor, VS Code, Windsurf, Gemini CLI und Codex CLI, kann sie die
Einrichtung für dich übernehmen. Zuerst:

1. Installiere [TradingView Desktop](https://www.tradingview.com/desktop/) und melde dich an.
2. Installiere [Node.js](https://nodejs.org) (die LTS-Version), falls du es noch nicht hast.

Kopiere dann diesen Prompt, füge ihn in deine KI-App ein und sende ihn ab:

```text
Installiere den TradingView-MCP-Server für mich. Es ist das npm-Paket tradingview-desktop-mcp
(https://github.com/Mochamad-Rizky/tradingview-desktop-mcp). Befolge diese Schritte und erkläre mir
jeden davon in einfachen Worten:

1. Prüfe, ob Node.js 20.19 oder neuer installiert ist. Falls nicht, hör auf und sag mir, wie ich es
   installiere.
2. Führe "npx -y tradingview-desktop-mcp config <client>" aus, wobei <client> die App ist, in der du
   läufst (claude-code, cursor, vscode, windsurf, gemini-cli oder codex-cli). Tu, was es ausgibt,
   um den Server zu meiner Konfiguration hinzuzufügen, und behalte alle anderen Server, die dort
   schon eingetragen sind.
3. Starte TradingView mit "npx -y tradingview-desktop-mcp launch". Wenn es meldet, dass TradingView
   bereits ohne den Debug-Port läuft, frag mich zuerst, und führe es nur mit meiner Zustimmung erneut
   mit --restart aus, denn das schließt TradingView und ich könnte ungespeicherte Änderungen verlieren.
4. Führe "npx -y tradingview-desktop-mcp doctor" aus und sag mir, ob alle Prüfungen bestanden sind.
   Wenn die Chart-Prüfung fehlschlägt, sag mir, dass ich den Chart-Tab in TradingView in den
   Vordergrund holen soll.
5. Sag mir, ob ich dich neu starten oder einen neuen Chat öffnen muss, bevor die TradingView-Tools
   erscheinen.
```

Wenn sie fertig ist, starte die App neu oder öffne einen neuen Chat, falls sie dich dazu aufgefordert
hat, und frage „Prüfe, ob TradingView verbunden ist.“ Probiere dann die
[Prompts weiter unten](#try-these-prompts) aus.

Du nutzt Claude Desktop? Es kann keine Befehle ausführen, aber Claude Code, Cursor und die anderen
oben genannten Apps können es für dich einrichten: Hänge „Richte es für Claude Desktop ein (config
claude-desktop), nicht für diese App.“ ans Ende des Prompts an. ChatGPT und die OpenAI API brauchen
einen Tunnel, den du von Hand einrichtest (siehe
[Entfernte Clients und Tunnel](#remote-clients-and-tunnels)). Wenn der Assistent nicht weiterkommt,
führe die Schritte unten selbst aus.

## <a id="install"></a>Installation

Du brauchst:

- TradingView Desktop, installiert und angemeldet.
- Node.js 20.19 oder neuer, das `npx` mitbringt.

Sonst wird nichts installiert: Die Clients unten starten den Server mit
`npx -y tradingview-desktop-mcp`, das das Paket beim ersten Aufruf herunterlädt. Starte TradingView
mit seinem Debug-Port. Der Befehl `launch` findet die App und startet sie auf diese Weise:

```sh
npx -y tradingview-desktop-mcp launch
```

TradingView erlaubt nur eine Instanz. Läuft es bereits ohne den Debug-Port, bricht `launch` ab und
meldet das; `launch --restart` beendet es ordnungsgemäß und startet es mit dem Port neu, wobei
TradingView dich vorher eventuell auffordert, Änderungen zu speichern. Prüfe, ob der Server die App
erreicht:

```sh
npx -y tradingview-desktop-mcp doctor
```

`doctor` besteht die Chart-Prüfung nicht, solange der Chart-Tab im Hintergrund liegt, hinter der
Seite „Neuer Tab“ oder einem anderen Tab ohne Chart; hol den Chart-Tab also in den Vordergrund.
`npx -y tradingview-desktop-mcp --help` listet die Optionen auf, [.env.example](../../.env.example) die
Umgebungsvariablen.

## <a id="connect-your-ai-app"></a>KI-App verbinden

`config <client>` gibt das Konfigurations-Snippet eines Clients aus und sagt, wohin es gehört. Jede
Anleitung unten enthält dasselbe Snippet, die Schritte für die jeweilige App und was zu tun ist, wenn
es nicht funktioniert.

| Client                                         | Snippet ausgeben                                       |
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

Der Standard-Transport ist stdio: stdout transportiert nur MCP-Nachrichten, Logs gehen nach stderr.
Die ersten sieben Clients starten den Server selbst. Unter Windows braucht ein Client, der `npx`
nicht direkt starten kann, die Form `cmd /c npx`, die `config` ausgibt, wenn es unter Windows läuft
(oder mit `--platform win32`). `--profile` reicht ein [Tool-Profil](#tool-profiles) an den Server
weiter.

### <a id="remote-clients-and-tunnels"></a>Entfernte Clients und Tunnel

ChatGPT und die OpenAI API können kein Programm auf deinem Computer starten. Sie erreichen den Server
über eine öffentliche HTTPS-Adresse, also betreibst du ihn über HTTP und schaltest einen Tunnel davor.
Damit steht ein Server, der dein angemeldetes TradingView steuern kann, im Internet: Verwende
`--profile readonly`, ein starkes Token (`TV_MCP_AUTH_TOKEN`), den öffentlichen Host des Tunnels in
`--allowed-hosts` (`TV_MCP_ALLOWED_HOSTS`) und `--no-dashboard`, damit die Dateien des Dashboards
nicht über den Tunnel ausgeliefert werden. Die Anleitungen für [ChatGPT](../clients/chatgpt.md) und
die [OpenAI API](../clients/openai-api.md) führen Schritt für Schritt durch, und
[SECURITY.md](../../SECURITY.md#tunnels-and-remote-clients) listet auf, was ein Nur-Lese-Token trotzdem
erreichen kann.

## <a id="quick-start-from-source"></a>Schnellstart aus dem Quellcode

Um einen Checkout statt des veröffentlichten Pakets auszuführen, brauchst du Node.js 24 zum Bauen des
Servers (`nvm use` liest `.nvmrc`) und [pnpm](https://pnpm.io) in der Version, die `package.json`
festlegt. Der gebaute Server läuft auf Node.js 20.19 oder neuer.

```sh
git clone https://github.com/Mochamad-Rizky/tradingview-desktop-mcp.git
cd tradingview-desktop-mcp
pnpm install && pnpm build
node packages/server/dist/cli.js launch
node packages/server/dist/cli.js doctor
```

`node packages/server/dist/cli.js config <client> --local` gibt das Snippet eines Clients für diesen
Checkout aus, mit `node` und dem absoluten Pfad von `cli.js` anstelle von `npx`. Für einen Client mit
JSON-Konfiguration sieht der Eintrag so aus:

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

Es gibt auch einen HTTP-Transport (`--transport http`); lies [SECURITY.md](../../SECURITY.md), bevor du ihn
verwendest.

## <a id="use-it"></a>Verwendung

Verbinde einen MCP-Client wie oben beschrieben, während TradingView mit seinem Debug-Port läuft, und
bitte in einfachen Worten um das, was du willst. Der Assistent wählt die Tools aus und ruft sie auf,
du musst ihre Namen also nicht kennen. Die [Tool-Referenz](../tools.md) listet jedes Tool mit seinen
Eingaben und den Profilen auf, zu denen es gehört.

### <a id="try-these-prompts"></a>Probiere diese Prompts aus

Jeder Prompt unten ist eines der Beispiele in [docs/examples.md](../examples.md). Dort stehen die
Tool-Aufrufe des Assistenten und ihre Ergebnisse, wobei Listen mit mehr als drei Einträgen gekürzt,
die Dauer jedes Aufrufs (`durationMs`) weggelassen und ein Screenshot in einer Notiz benannt statt
gezeigt wird. Die Auszüge sind Zeilen aus diesen Ergebnissen, und `…` markiert, wo Zeilen aus anderen
Teilen eines Ergebnisses ausgelassen sind. Die Werte sind synthetisch: Sie stammen aus einer
nachgebauten TradingView-App mit einem erfundenen NASDAQ:AAPL-Chart, nichts davon sind also
Marktdaten und nichts stammt aus einem Konto. Die Ergebnisse haben die Form, die der Server ihnen
gibt, allerdings wurde der Strategy-Tester-Bericht hinter dem Backtest-Beispiel noch nicht aus der
echten App gelesen.

**„Was sehe ich gerade auf meinem Chart? Nenn mir das Symbol, den Zeitrahmen und welche Indikatoren
darauf sind.“** Der Assistent liest den Chart mit `chart_get_state`
([Details](../examples.md#1-read-the-chart)):

```json
"symbol": "NASDAQ:AAPL",
"resolution": "1D",
"chartTypeName": "candles",
```

**„Zeig mir die letzten 3 Tageskerzen.“** Er liest die Bars mit `data_get_ohlcv`
([Details](../examples.md#3-read-the-last-candles)):

```json
"timeIso": "2024-10-27T00:00:00Z",
"open": 103.58,
"close": 103.42,
```

**„Füge meinem Chart den MACD hinzu.“** Auf einem Chart, der bereits so viele Indikatoren enthält,
wie der Tarif erlaubt, fügt `indicator_add` nichts hinzu und meldet das Limit, und das Entfernen
eines deiner Indikatoren, um Platz zu schaffen, erfordert deine Bestätigung
([Details](../examples.md#5-add-an-indicator-to-a-full-chart)):

```json
"code": "PLAN_LIMIT",
"message": "The chart holds as many indicators as the plan allows (2)",
```

**„Schreib einen Pine-Script-Indikator, der einen gleitenden 9-Bar- und einen 21-Bar-Durchschnitt des
Schlusskurses zeichnet, und prüfe, ob er kompiliert.“** Er legt das Skript mit `pine_new` im Pine
Editor an und kompiliert es mit `pine_compile`
([Details](../examples.md#6-write-and-compile-a-pine-script)):

```json
"success": true,
"errors": [],
"warnings": [],
```

**„Das Skript in meinem Pine Editor lässt sich nicht kompilieren. Kannst du es reparieren?“**
`pine_smart_compile` kompiliert das Skript, wendet regelbasierte Korrekturen für die Fehler an, die
es kennt, etwa Pine-v4-Namen in einem v6-Skript, und kompiliert erneut, ohne den Editor zu verändern
([Details](../examples.md#7-fix-a-pine-script-with-smart-compile)):

```json
"message": "Could not find function or function reference 'study'",
…
"applied": ["Replace study( with indicator(", "Replace rsi( with ta.rsi("]
…
"writtenBack": false
```

**„Wie hat die Strategie auf meinem Chart im Backtest abgeschnitten?“** Er liest den Strategy Tester
mit `strategy_get_results` und `strategy_get_trades`
([Details](../examples.md#8-read-backtest-results)):

```json
"netProfit": 155,
"totalTrades": 3,
"percentProfitable": 66.67,
"profitFactor": 4.1,
```

**„Zeichne eine Unterstützungslinie bei 102,80 auf meinem Chart.“** Er zeichnet mit `drawing_create`
eine horizontale Linie, und `drawing_list` zeigt sie neben deinen eigenen Zeichnungen an, markiert
als von dieser Sitzung gezeichnet ([Details](../examples.md#9-draw-a-support-line)):

```json
"id": "DRW001",
"shape": "horizontal_line",
"text": "Support",
"createdByServer": true
```

**„Benachrichtige mich, wenn Apple die 110 kreuzt.“** `alert_create` setzt einen Preisalarm in deinem
TradingView-Konto ([Details](../examples.md#10-create-a-price-alert)). Wenn der Tarif bereits so
viele Alarme enthält, wie er erlaubt, legt es nichts an und meldet das Limit, und `alert_list` zeigt
die Alarme, die ihn ausschöpfen ([Details](../examples.md#11-create-an-alert-when-the-plan-is-full)):

```json
"symbol": "NASDAQ:AAPL",
"condition": "crossing",
"price": 110,
"expirationIso": "2024-11-26T00:00:00Z"
```

**„Füge diese Symbole zu meiner Watchlist hinzu: NYSE:IBM, FX:EURUSD, NASDAQ:MSFT und NASDAQ:MSTF.“**
`watchlist_add_bulk` prüft jedes Symbol mit der Symbolsuche von TradingView, fügt die neuen hinzu und
erklärt, warum es die anderen übersprungen hat ([Details](../examples.md#12-add-symbols-to-a-watchlist)):

```json
"added": ["NYSE:IBM", "FX:EURUSD"],
…
{ "symbol": "NASDAQ:MSFT", "reason": "already_listed" },
{ "symbol": "NASDAQ:MSTF", "reason": "unknown" }
```

**„Lass mich mit einem Bar Replay meines Charts ab dem 2024-06-03 üben: geh fünf Bars vorwärts, sag
mir, wo wir stehen, und beende dann das Replay.“** Er startet das Bar Replay mit `replay_start`, geht
mit `replay_step` vorwärts, liest mit `replay_status`, wo das Replay steht, und verlässt es mit
`replay_stop`. Gehandelt wird nichts: Kein Tool platziert Orders
([Details](../examples.md#13-practice-with-bar-replay)):

```json
"dateIso": "2024-06-07T00:00:00Z",
"stepped": 5,
…
"position": null,
"realizedPL": null
```

**„Mach einen Screenshot von meinem Chart.“** `screenshot_capture` übergibt das Bild samt seiner
Größe als Bild an den Assistenten und schreibt nichts auf die Festplatte
([Details](../examples.md#14-take-a-screenshot)):

```json
"data": { "target": "chart", "format": "jpeg", "width": 1180, "height": 640, "bytes": 3100 },
"meta": { "via": "cdp", "warnings": [] }
```

Der Server bietet außerdem fünf eigene Prompts, die ein Client mit Unterstützung für MCP-Prompts zur
Auswahl anzeigt: `analyze_current_chart`, `multi_timeframe_review`, `write_and_backtest_strategy`,
`debug_pine_script` und `replay_practice_session`. Jeder davon sagt dem Assistenten, welche Tools er
in welcher Reihenfolge aufrufen und was er zurückmelden soll. `replay_practice_session` führt eine
Übungssitzung im Bar Replay durch: Der Assistent geht Bar für Bar durch die Vergangenheit, fragt dich
bei jedem Schritt, ob du long gehen, short gehen oder flat bleiben würdest, führt ein Journal dieser
hypothetischen Trades zu Kursen, die er aus dem Chart liest, und berechnet ihren Gewinn oder Verlust.
Zuerst prüft er, ob gerade ein Replay von dir läuft, und fragt dich, was damit geschehen soll, bevor
er irgendetwas ändert; am Ende stoppt er das Replay, das er selbst gestartet hat, und niemals eines
von deinen.

### <a id="safety"></a>Sicherheit

Die Tools, die deinen Chart, deine Skripte oder dein Konto verändern, gehen vorsichtig mit dem um,
was bereits dir gehört. Ungespeicherten Text im Pine Editor ersetzen (außer einer ungespeicherten
Änderung, die diese Sitzung des Servers dort selbst vorgenommen hat), eine neue Version eines Skripts
speichern, das diese Sitzung nicht erstellt hat, und einen Indikator entfernen, der bereits auf
deinem Chart war, erfordern jeweils `confirm: true`, das der Assistent erst nach deiner Zustimmung
übergeben sollte. Dasselbe gilt für das Entfernen einer Zeichnung, eines Alarms, eines
Watchlist-Symbols oder eines Tabs, die diese Sitzung nicht erstellt, hinzugefügt oder geöffnet hat,
für das Entfernen aller Zeichnungen eines Charts, für das Verlassen eines Layouts mit ungespeicherten
Änderungen und für den Wechsel zu einem Multi-Chart-Layout mit weniger Charts, als der Tab anzeigt,
dessen nächstes Speichern die übrigen verwerfen würde. Ein Tariflimit, etwa die Anzahl der
Indikatoren auf einem Chart, der gespeicherten Skripte, der Alarme oder der Charts eines Layouts, wird
geprüft, bevor etwas hinzugefügt wird, und als `PLAN_LIMIT`-Fehler mit dem Limit gemeldet; lässt sich
das Limit in deinem TradingView-Build nicht auslesen, tut das Tool nichts und sagt das. Der Server
umgeht kein Limit. Die Tools prüfen vorab, was TradingView dazu bringen würde, seinen Upgrade-Dialog
oder einen anderen eigenen Dialog zu öffnen, und verweigern stattdessen, doch einige Abfragen bleiben,
die diese Prüfungen nicht vorhersehen können: `layout_switch` kann auf eine Upgrade-Abfrage stoßen bei
einem gespeicherten Multi-Chart-Layout in einem Tarif mit weniger Charts, bei einem Layout, das der
Server von TradingView als über dem Limit ablehnt, und bei einem, das die Liste, die TradingView für
sich selbst führt, als über dem Limit markiert, während `layout_list` das nicht tut; `layout_new` kann
auf eine Meldung von TradingView stoßen, wenn es das neue Layout nach den Prüfungen ablehnt; und
`tab_close` kann auf den Dialog „Tab schließen?“ stoßen bei einer Seite, die länger braucht, als
TradingView wartet, um mitzuteilen, ob ihr Layout ungespeicherte Änderungen hat, oder die eine
laufende Aufnahme meldet. Die Low-Level-Tools `ui_*` klicken und tippen, was du verlangst, und können
daher bewusst Dialoge von TradingView öffnen. Der Server löscht und benennt kein Skript um.

Kein Tool platziert Orders: Bar Replay dient zum Üben, und der Assistent hält etwaige Übungstrades im
Gespräch fest. Screenshots gehen als Bilder an den Client, und der Server schreibt keinen davon auf
die Festplatte. `ui_evaluate`, das JavaScript in der Chart-Seite ausführt, ist deaktiviert, sofern du
den Server nicht mit `--allow-eval` (`TV_MCP_ALLOW_EVAL=true`) startest.

### <a id="tool-profiles"></a>Tool-Profile

Standardmäßig bietet der Server alle seine 83 Tools an (`--profile full`). Manche Clients akzeptieren
nur eine begrenzte Anzahl an Tools (Cursor warnt ab 40). Für sie bietet `--profile core` eine
reduzierte Auswahl von 40 wesentlichen Tools, und `--profile readonly` bietet nur die 37 Tools, die
lesen. `--tools` nimmt Namensmuster wie `chart_*,data_*` entgegen und grenzt das Profil weiter ein:
Ein Tool muss im Profil enthalten sein und auf ein Muster passen, daher lässt
`--profile core --tools 'pine_*'` weiterhin `pine_open` und `pine_save` weg, die keine Core-Tools
sind; mit dem Standardprofil wählt `--tools` allein die Tools aus. Manche Beschreibungen und Hinweise
nennen Tools, die `core` weglässt, etwa `pine_open` und `pine_save`, die der Assistent unter `core`
nicht aufrufen kann. Die Ressourcen folgen den Tools: Jede wird nur zusammen mit dem Tool angeboten,
dessen Daten sie teilt, etwa `tradingview://pine/source` mit `pine_get_source`, sodass
`--tools 'chart_*'` den Chart-Zustand anbietet und nichts aus dem Pine Editor.

Die [Tool-Referenz](../tools.md) listet jedes Tool mit seinen Eingaben und den Profilen auf, zu
denen es gehört.

## <a id="troubleshooting"></a>Fehlerbehebung

[docs/troubleshooting.md](../troubleshooting.md) erklärt jeden Fehlercode und was zu tun ist, wenn
TradingView nicht gefunden wird, der Debug-Port belegt ist, ein Client die Tools nicht anzeigt oder
ein Tunnel eine Anfrage ablehnt. `npx -y tradingview-desktop-mcp doctor` ist das Erste, was du
ausführen solltest.

## <a id="dashboard"></a>Dashboard

Der Server bringt ein Web-Dashboard mit, um zu verfolgen, was dein Assistent tut, und um ein Tool von
Hand auszuprobieren. Es braucht keine zusätzliche Installation: Das veröffentlichte Paket enthält es,
und `pnpm build` baut es in den Server eines Checkouts ein.

![Die Statusseite: TradingView erreichbar, ein Chart gefunden und die App bereit, die Eckdaten des Servers und die Tariflimits](../images/dashboard-status.png)

### <a id="open-it"></a>Öffnen

- **HTTP-Transport:** Starte den Server mit einem Token und öffne `http://127.0.0.1:8787/`. Das
  Dashboard ist in diesem Modus standardmäßig aktiv; `--no-dashboard` (`TV_MCP_DASHBOARD=false`)
  schaltet es ab.

  ```sh
  TV_MCP_AUTH_TOKEN="$(openssl rand -hex 32)" npx -y tradingview-desktop-mcp --transport http
  ```

  Aus einem Checkout führst du stattdessen `node packages/server/dist/cli.js --transport http` aus.

- **Neben stdio:** Auch ein MCP-Client, der den Server über stdio startet, kann ein Dashboard haben.
  Füge `--dashboard` (`TV_MCP_DASHBOARD=true`) und `TV_MCP_AUTH_TOKEN` zu seiner Konfiguration hinzu.
  Das Dashboard lauscht auf einer eigenen Adresse, `127.0.0.1:8787`, sofern du nicht `--host` und
  `--port` setzt, und stellt kein `/mcp` bereit. Ohne das Token oder wenn der Port belegt ist, bleibt
  das Dashboard aus und der Server protokolliert eine Warnung, der MCP-Server läuft aber weiter. Die
  Aufrufe des Clients erscheinen im Live-Log.

Der Server gibt beim Start die Adresse des Dashboards auf stderr aus. Das Token gibt er nie aus.

### <a id="the-token"></a>Das Token

Die Seite fragt nach dem Token (`TV_MCP_AUTH_TOKEN`), bevor sie irgendetwas anzeigt. Füge es ein, oder
öffne einmal `http://127.0.0.1:8787/#token=<token>`: Die Seite liest das Token aus dem Fragment und
entfernt es aus der Adresse, und das Fragment wird nie an den Server gesendet. Die Seite hält das
Token in `sessionStorage`, es ist also weg, sobald du den Tab schließt, und sie sendet es nur als
`Authorization: Bearer <token>`, nie in einer URL. Startet der Server mit einem anderen Token neu,
fragt die Seite erneut. Siehe [SECURITY.md](../../SECURITY.md#the-dashboard).

### <a id="what-it-shows"></a>Was es anzeigt

![Das Live-Log: eine Tabelle der Tool-Aufrufe, die neuesten zuerst, mit Zeit, Tool, Herkunft, Status und Dauer, darüber Suche und Filter](../images/dashboard-log.png)

- **Status** zeigt, ob TradingView erreichbar ist (und wie du es startest, wenn nicht), wie der
  Server läuft, die Tariflimits und die letzten Aufrufe.
- **Log** streamt jeden Tool-Aufruf, den der Server ausführt, egal ob ein MCP-Client oder das
  Dashboard ihn ausgelöst hat, mit einem Filter nach Toolname, Pause, Leeren und den Details jedes
  Aufrufs. Nach einem Verbindungsabbruch zeigt es „Verbindung wird wiederhergestellt…“ an und macht
  dort weiter, wo es aufgehört hat. Jeder offene Tab des Dashboards hält einen Event-Stream zum
  Server, und ein Browser erlaubt etwa sechs Verbindungen zu einem Host; bei vielen offenen
  Dashboard-Tabs kann ein neuer daher auf eine freie Verbindung warten: Schließ die Tabs, die du
  nicht brauchst.
- **Tools** listet die Tools auf, die der Server anbietet, mit ihren Eingaben, und führt eines von
  Hand aus. Das Ergebnis wird so angezeigt, wie es zurückkam, mit langem JSON hinter „Alles anzeigen“
  eingeklappt und Bildern als Bilder.

![Die Tools-Seite: links die Tool-Liste mit Suche und Filtern, rechts chart_get_state mit Beschreibung, Eckdaten und Eingabefeldern](../images/dashboard-tools.png)

Ein Lauf aus dem Dashboard ist ein echter Tool-Aufruf. Er geht über dieselbe Registry wie ein
MCP-Aufruf, daher gelten dieselben Schemas, dasselbe Profil, dieselben `confirm`-Regeln und
Tariflimit-Prüfungen, und er erscheint im Log. Das Dashboard bittet dich um Bestätigung, bevor es ein
Tool ausführt, das nicht nur liest.

### <a id="the-api"></a>Die API

Die Seite spricht mit dem Server über eine kleine API, die du auch mit `curl` und dem Token aufrufen
kannst. Jede Route erfordert `Authorization: Bearer <token>`, und der Server prüft `Host` und
`Origin` so wie bei `/mcp`.

| Route                    | Was sie tut                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `GET /api/info`          | Version, Transport, Profil, Anzahl der Tools und Startzeit                            |
| `GET /api/health`        | Der Zustandsbericht: ob TradingView erreichbar ist                                    |
| `GET /api/tools`         | Die angebotenen Tools mit ihren Schemas und Annotationen                              |
| `POST /api/tools/<name>` | Führt ein Tool mit `{"arguments": {...}}` aus, mit der Herkunft `dashboard`           |
| `GET /api/events`        | Server-Sent Events der Tool-Aufrufe; `?limit=` legt fest, wie viele wiederholt werden |

Die Dateien der Seite selbst, unter `/`, brauchen kein Token und enthalten keine Daten.

## <a id="contributing"></a>Mitwirken

Siehe [CONTRIBUTING.md](../../CONTRIBUTING.md) für die lokale Einrichtung, die Teststufen, die
Commit-Konventionen und wie ein Release entsteht, sowie [docs/testing.md](../testing.md) für den
Testleitfaden. Um eine Sicherheitslücke zu melden, folge [SECURITY.md](../../SECURITY.md).

## <a id="disclaimer"></a>Haftungsausschluss

Dieses Projekt ist nicht mit TradingView, Inc. verbunden und wird von TradingView, Inc. weder
unterstützt noch gesponsert. TradingView ist eine Marke ihres Inhabers. Nichts hier ist eine
Finanzberatung. Die Tools verändern, was die App anzeigt, und können auf ihre Bedienelemente
zugreifen; du bist also selbst verantwortlich für das, was du automatisierst, und für die Einhaltung
der Nutzungsbedingungen von TradingView.

## <a id="license"></a>Lizenz

Veröffentlicht unter der [MIT-Lizenz](../../LICENSE).
