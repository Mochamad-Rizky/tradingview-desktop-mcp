# tradingview-desktop-mcp

[English](../../README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Türkçe](README.tr.md) · [Русский](README.ru.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Українська](README.uk.md) · **Polski** · [Português (Brasil)](README.pt-BR.md) · [العربية](README.ar.md) · [فارسی](README.fa.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Ελληνικά](README.el.md) · [മലയാളം](README.ml.md) · [Roman Urdu](README.ur-Latn.md) · [Română](README.ro.md)

[![npm](https://img.shields.io/npm/v/tradingview-desktop-mcp)](https://www.npmjs.com/package/tradingview-desktop-mcp)
[![CI](https://github.com/Mochamad-Rizky/tradingview-desktop-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Mochamad-Rizky/tradingview-desktop-mcp/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/Mochamad-Rizky/tradingview-desktop-mcp/graph/badge.svg)](https://codecov.io/gh/Mochamad-Rizky/tradingview-desktop-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../../LICENSE)

> To jest tłumaczenie [angielskiego README](../../README.md). Jeśli obie wersje się różnią, rozstrzygająca jest wersja angielska.

<p align="center">
  <a href="../media/promo.mp4"><img src="../media/teaser.gif" width="49%" alt="Film przeglądowy: asystent odczytuje wykres, rysuje linię wsparcia, pisze skrypt Pine Script i ustawia alert cenowy"></a>
  <a href="../media/tutorial.mp4"><img src="../media/tutorial-poster.jpg" width="49%" alt="Samouczek konfiguracji: konfiguracja w pięciu krokach"></a>
</p>

<p align="center">
  <a href="../media/promo.mp4"><b>▶ Obejrzyj film przeglądowy</b></a> (0:48) &nbsp;·&nbsp;
  <a href="../media/tutorial.mp4"><b>▶ Obejrzyj samouczek konfiguracji</b></a> (1:53)<br>
  <sub>Oba filmy pokazują zmyślony wykres, a nie dane rynkowe.</sub>
</p>

Serwer [MCP](https://modelcontextprotocol.io), który pozwala asystentom AI odczytywać i sterować
aplikacją TradingView Desktop na Twoim własnym komputerze. Steruje aplikacją, w której już jesteś
zalogowany, przez Chrome DevTools Protocol, korzystając z portu debugowania, który aplikacja otwiera
po uruchomieniu z `--remote-debugging-port`. Automatyzuje wyłącznie lokalną aplikację: nie loguje
się za Ciebie, nie obchodzi limitów planu i nie wywołuje serwerów TradingView.

> **Status: przed wersją 1.0.** Nazwy narzędzi i opcje mogą się zmienić przed wersją 1.0. Zainstaluj
> pakiet z npm, jak opisano poniżej, albo uruchom serwer [ze źródeł](#quick-start-from-source).
> Był testowany na macOS; Windows i Linux są wspierane w miarę możliwości.

Serwer udostępnia narzędzia aplikacji (uruchamianie, stan, wykrywanie, stan interfejsu, limity
planu, ponowne połączenie), narzędzia wykresu (stan, symbol, interwał, typ wykresu, widoczny zakres,
przewijanie), narzędzia danych rynkowych (świece, notowania, informacje o symbolu i wyszukiwanie),
narzędzia wskaźników (lista, wyszukiwanie, dodawanie, usuwanie, parametry wejściowe, widoczność,
wartości), narzędzia Pine Script (edytor i zapisane skrypty, kompilacja, inteligentna kompilacja z
poprawkami opartymi na regułach, analiza offline, konsola oraz linie, etykiety, prostokąty i tabele
rysowane przez skrypty), narzędzia Strategy Tester (wyniki, transakcje, kapitał), narzędzia do
rysunków, alertów i list obserwowanych, narzędzia układów, wielu wykresów i kart, odtwarzanie świec
(bar replay), zrzuty ekranu, niskopoziomowe narzędzia interfejsu (klikanie, najeżdżanie, pisanie,
klawisze, przewijanie, wyszukiwanie, panele, pełny ekran oraz JavaScript na stronie wykresu, jeśli
na to pozwolisz) oraz `batch_run`, które uruchamia kilka narzędzi w jednym wywołaniu. Udostępnia też
zasoby (stan aplikacji, stan wykresu i świece, źródło Pine i ostatni wynik kompilacji, raport
strategii, aktywna lista obserwowanych), każdy razem z narzędziem, z którym dzieli dane, oraz pięć
promptów do typowych zadań. Panel webowy pokazuje wywołania na żywo i pozwala uruchamiać narzędzia
ręcznie (zobacz [Panel](#dashboard)).

Spis treści: [Instalacja przez poproszenie aplikacji AI](#install-by-asking-your-ai-app), [Instalacja](#install),
[Podłączenie aplikacji AI](#connect-your-ai-app), [Zdalni klienci i tunele](#remote-clients-and-tunnels),
[Szybki start ze źródeł](#quick-start-from-source), [Użytkowanie](#use-it),
[Rozwiązywanie problemów](#troubleshooting), [Panel](#dashboard), [Współtworzenie](#contributing).

## <a id="install-by-asking-your-ai-app"></a>Instalacja przez poproszenie aplikacji AI

Nie musisz samodzielnie wpisywać żadnych poleceń. Jeśli Twoja aplikacja AI potrafi uruchamiać
polecenia na Twoim komputerze, jak Claude Code, Cursor, VS Code, Windsurf, Gemini CLI i Codex CLI,
może przeprowadzić konfigurację za Ciebie. Najpierw:

1. Zainstaluj [TradingView Desktop](https://www.tradingview.com/desktop/) i zaloguj się.
2. Zainstaluj [Node.js](https://nodejs.org) (wersję LTS), jeśli jeszcze go nie masz.

Następnie skopiuj ten prompt, wklej go do aplikacji AI i wyślij:

```text
Zainstaluj dla mnie serwer TradingView MCP. To pakiet npm tradingview-desktop-mcp
(https://github.com/Mochamad-Rizky/tradingview-desktop-mcp). Wykonaj poniższe kroki i wyjaśnij mi
każdy z nich prostymi słowami:

1. Sprawdź, czy zainstalowany jest Node.js 20.19 lub nowszy. Jeśli nie, przerwij i powiedz mi, jak go zainstalować.
2. Uruchom "npx -y tradingview-desktop-mcp config <client>", gdzie <client> to aplikacja, w której
   działasz (claude-code, cursor, vscode, windsurf, gemini-cli lub codex-cli). Zrób to, co wypisze,
   aby dodać serwer do mojej konfiguracji, i zachowaj wszystkie inne serwery, które już tam są.
3. Uruchom TradingView poleceniem "npx -y tradingview-desktop-mcp launch". Jeśli poinformuje, że
   TradingView już działa bez portu debugowania, najpierw mnie zapytaj i dopiero gdy się zgodzę,
   uruchom je ponownie z --restart, bo to zamyka TradingView i mogę stracić niezapisane zmiany.
4. Uruchom "npx -y tradingview-desktop-mcp doctor" i powiedz mi, czy wszystkie testy przechodzą.
   Jeśli test wykresu się nie powiedzie, powiedz mi, żebym przeniósł kartę z wykresem na wierzch w TradingView.
5. Powiedz mi, czy muszę Cię zrestartować albo otworzyć nowy czat, zanim pojawią się narzędzia TradingView.
```

Gdy skończy, zrestartuj aplikację albo otwórz nowy czat, jeśli tak Ci powiedziała, i zapytaj
„Sprawdź, czy TradingView jest połączone”. Potem wypróbuj [prompty poniżej](#try-these-prompts).

Używasz Claude Desktop? Nie potrafi on uruchamiać poleceń, ale Claude Code, Cursor i pozostałe
aplikacje wymienione wyżej mogą go skonfigurować za Ciebie: dopisz na końcu promptu „Skonfiguruj to
dla Claude Desktop (config claude-desktop), a nie dla tej aplikacji”. ChatGPT i OpenAI API wymagają
tunelu, który konfigurujesz ręcznie (zobacz [Zdalni klienci i tunele](#remote-clients-and-tunnels)).
Jeśli asystent utknie, wykonaj poniższe kroki samodzielnie.

## <a id="install"></a>Instalacja

Potrzebujesz:

- TradingView Desktop, zainstalowanego i z zalogowanym kontem.
- Node.js 20.19 lub nowszego, który dostarcza `npx`.

Nic więcej nie jest instalowane: klienci opisani poniżej uruchamiają serwer przez
`npx -y tradingview-desktop-mcp`, które pobiera pakiet przy pierwszym użyciu. Uruchom TradingView z
portem debugowania. Polecenie `launch` znajduje aplikację i uruchamia ją w ten sposób:

```sh
npx -y tradingview-desktop-mcp launch
```

TradingView pozwala na tylko jedną instancję. Jeśli już działa bez portu debugowania, `launch`
przerywa i to zgłasza; `launch --restart` grzecznie ją zamyka i uruchamia ponownie z portem, a
TradingView może najpierw poprosić o zapisanie zmian. Sprawdź, czy serwer może połączyć się z aplikacją:

```sh
npx -y tradingview-desktop-mcp doctor
```

`doctor` nie przechodzi testu wykresu, gdy karta z wykresem jest w tle, za stroną nowej karty albo
inną kartą bez wykresu, więc przenieś kartę z wykresem na wierzch.
`npx -y tradingview-desktop-mcp --help` wypisuje opcje, a [.env.example](../../.env.example) zmienne
środowiskowe.

## <a id="connect-your-ai-app"></a>Podłączenie aplikacji AI

`config <client>` wypisuje fragment konfiguracji dla danego klienta i mówi, gdzie go umieścić. Każdy
z poniższych samouczków zawiera ten sam fragment, kroki dla danej aplikacji i co zrobić, gdy coś nie
działa.

| Klient                                         | Wypisz fragment konfiguracji                           |
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

Domyślnym transportem jest stdio, w którym stdout przenosi wyłącznie komunikaty MCP, a logi trafiają
na stderr. Pierwszych siedmiu klientów uruchamia serwer samodzielnie. W systemie Windows klient,
który nie potrafi bezpośrednio uruchomić `npx`, potrzebuje formy `cmd /c npx`, którą `config`
wypisuje, gdy działa w Windows (albo z `--platform win32`). `--profile` przekazuje do serwera
[profil narzędzi](#tool-profiles).

### <a id="remote-clients-and-tunnels"></a>Zdalni klienci i tunele

ChatGPT i OpenAI API nie mogą uruchomić programu na Twoim komputerze. Łączą się z serwerem pod
publicznym adresem HTTPS, więc uruchamiasz go przez HTTP i stawiasz przed nim tunel. W ten sposób
wystawiasz do internetu serwer, który może sterować Twoim zalogowanym TradingView: użyj
`--profile readonly`, silnego tokenu (`TV_MCP_AUTH_TOKEN`), publicznego hosta tunelu w
`--allowed-hosts` (`TV_MCP_ALLOWED_HOSTS`) oraz `--no-dashboard`, aby pliki panelu nie były
serwowane przez tunel. Samouczki dla [ChatGPT](../clients/chatgpt.md) i
[OpenAI API](../clients/openai-api.md) prowadzą przez ten proces krok po kroku, a
[SECURITY.md](../../SECURITY.md#tunnels-and-remote-clients) wymienia, do czego token tylko do odczytu
nadal ma dostęp.

## <a id="quick-start-from-source"></a>Szybki start ze źródeł

Aby uruchomić kopię repozytorium zamiast opublikowanego pakietu, potrzebujesz Node.js 24 do
zbudowania serwera (`nvm use` odczytuje `.nvmrc`) oraz [pnpm](https://pnpm.io) w wersji przypiętej w
`package.json`. Zbudowany serwer działa na Node.js 20.19 lub nowszym.

```sh
git clone https://github.com/Mochamad-Rizky/tradingview-desktop-mcp.git
cd tradingview-desktop-mcp
pnpm install && pnpm build
node packages/server/dist/cli.js launch
node packages/server/dist/cli.js doctor
```

`node packages/server/dist/cli.js config <client> --local` wypisuje fragment konfiguracji klienta
dla tej kopii repozytorium, z `node` i bezwzględną ścieżką do `cli.js` zamiast `npx`. Dla klienta z
konfiguracją w JSON wpis wygląda tak:

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

Dostępny jest też transport HTTP (`--transport http`); przed jego użyciem przeczytaj
[SECURITY.md](../../SECURITY.md).

## <a id="use-it"></a>Użytkowanie

Podłącz klienta MCP, jak opisano wyżej, przy TradingView uruchomionym z portem debugowania, i poproś
o to, czego potrzebujesz, zwykłymi słowami. Asystent sam wybiera narzędzia i je wywołuje, więc nie
musisz znać ich nazw. [Dokumentacja narzędzi](../tools.md) wymienia każde narzędzie wraz z jego
parametrami wejściowymi i profilami, do których należy.

### <a id="try-these-prompts"></a>Wypróbuj te prompty

Każdy z poniższych promptów to jeden z przykładów w [docs/examples.md](../examples.md), który
pokazuje wywołania narzędzi wykonywane przez asystenta i ich wyniki, przy czym listy dłuższe niż trzy
elementy są przycięte, czas trwania każdego wywołania (`durationMs`) jest pominięty, a zrzut ekranu
jest wspomniany w notatce zamiast pokazany. Fragmenty to wiersze tych wyników, a `…` oznacza miejsce,
w którym pominięto wiersze innych części wyniku. Wartości są syntetyczne: pochodzą z fałszywej
aplikacji TradingView ze zmyślonym wykresem NASDAQ:AAPL, więc nic nie jest danymi rynkowymi i nic nie
pochodzi z konta; wyniki mają kształt, jaki nadaje im serwer, choć raport Strategy Tester, na którym
opiera się przykład backtestu, nie został jeszcze odczytany z prawdziwej aplikacji.

**„Na co patrzę na moim wykresie? Podaj symbol, interwał i jakie wskaźniki są na nim.”** Asystent
odczytuje wykres za pomocą `chart_get_state`
([szczegóły](../examples.md#1-read-the-chart)):

```json
"symbol": "NASDAQ:AAPL",
"resolution": "1D",
"chartTypeName": "candles",
```

**„Pokaż mi ostatnie 3 świece dzienne.”** Odczytuje świece za pomocą `data_get_ohlcv`
([szczegóły](../examples.md#3-read-the-last-candles)):

```json
"timeIso": "2024-10-27T00:00:00Z",
"open": 103.58,
"close": 103.42,
```

**„Dodaj MACD do mojego wykresu.”** Na wykresie, który ma już tyle wskaźników, ile pozwala plan,
`indicator_add` niczego nie dodaje i zgłasza limit, a usunięcie jednego z Twoich wskaźników, aby
zrobić miejsce, wymaga Twojego potwierdzenia
([szczegóły](../examples.md#5-add-an-indicator-to-a-full-chart)):

```json
"code": "PLAN_LIMIT",
"message": "The chart holds as many indicators as the plan allows (2)",
```

**„Napisz wskaźnik w Pine Script, który rysuje 9-świecową i 21-świecową średnią kroczącą z ceny
zamknięcia, i sprawdź, czy się kompiluje.”** Umieszcza skrypt w Pine Editor za pomocą `pine_new` i
kompiluje go za pomocą `pine_compile`
([szczegóły](../examples.md#6-write-and-compile-a-pine-script)):

```json
"success": true,
"errors": [],
"warnings": [],
```

**„Skrypt w moim Pine Editor się nie kompiluje. Możesz go naprawić?”** `pine_smart_compile`
kompiluje skrypt, stosuje oparte na regułach poprawki znanych mu błędów, na przykład nazw z Pine v4
w skrypcie v6, i kompiluje ponownie, nie zmieniając zawartości edytora
([szczegóły](../examples.md#7-fix-a-pine-script-with-smart-compile)):

```json
"message": "Could not find function or function reference 'study'",
…
"applied": ["Replace study( with indicator(", "Replace rsi( with ta.rsi("]
…
"writtenBack": false
```

**„Jak wypadła w backteście strategia na moim wykresie?”** Odczytuje Strategy Tester za pomocą
`strategy_get_results` i `strategy_get_trades`
([szczegóły](../examples.md#8-read-backtest-results)):

```json
"netProfit": 155,
"totalTrades": 3,
"percentProfitable": 66.67,
"profitFactor": 4.1,
```

**„Narysuj linię wsparcia na poziomie 102.80 na moim wykresie.”** Rysuje linię poziomą za pomocą
`drawing_create`, a `drawing_list` pokazuje ją obok Twoich własnych rysunków, oznaczoną jako
narysowaną przez tę sesję ([szczegóły](../examples.md#9-draw-a-support-line)):

```json
"id": "DRW001",
"shape": "horizontal_line",
"text": "Support",
"createdByServer": true
```

**„Powiadom mnie, gdy Apple przekroczy 110.”** `alert_create` ustawia alert cenowy na Twoim koncie
TradingView ([szczegóły](../examples.md#10-create-a-price-alert)). Gdy plan ma już tyle alertów,
ile pozwala, niczego nie tworzy i zgłasza limit, a `alert_list` pokazuje alerty, które go wypełniają
([szczegóły](../examples.md#11-create-an-alert-when-the-plan-is-full)):

```json
"symbol": "NASDAQ:AAPL",
"condition": "crossing",
"price": 110,
"expirationIso": "2024-11-26T00:00:00Z"
```

**„Dodaj te symbole do mojej listy obserwowanych: NYSE:IBM, FX:EURUSD, NASDAQ:MSFT i NASDAQ:MSTF.”**
`watchlist_add_bulk` sprawdza każdy symbol w wyszukiwarce symboli TradingView, dodaje nowe i podaje,
dlaczego pominął pozostałe ([szczegóły](../examples.md#12-add-symbols-to-a-watchlist)):

```json
"added": ["NYSE:IBM", "FX:EURUSD"],
…
{ "symbol": "NASDAQ:MSFT", "reason": "already_listed" },
{ "symbol": "NASDAQ:MSTF", "reason": "unknown" }
```

**„Chcę poćwiczyć na odtwarzaniu świec mojego wykresu od 2024-06-03: przesuń się o pięć świec do
przodu, powiedz mi, gdzie jesteśmy, a potem zakończ odtwarzanie.”** Uruchamia odtwarzanie świec za
pomocą `replay_start`, przesuwa się za pomocą `replay_step`, odczytuje stan odtwarzania za pomocą
`replay_status` i kończy je za pomocą `replay_stop`. Nic nie jest handlowane: żadne narzędzie nie
składa zleceń ([szczegóły](../examples.md#13-practice-with-bar-replay)):

```json
"dateIso": "2024-06-07T00:00:00Z",
"stepped": 5,
…
"position": null,
"realizedPL": null
```

**„Zrób zrzut ekranu mojego wykresu.”** `screenshot_capture` przekazuje obraz asystentowi jako
grafikę, razem z jej rozmiarem, i niczego nie zapisuje na dysku
([szczegóły](../examples.md#14-take-a-screenshot)):

```json
"data": { "target": "chart", "format": "jpeg", "width": 1180, "height": 640, "bytes": 3100 },
"meta": { "via": "cdp", "warnings": [] }
```

Serwer udostępnia też pięć własnych promptów, które klient obsługujący prompty MCP wyświetla do
wyboru: `analyze_current_chart`, `multi_timeframe_review`, `write_and_backtest_strategy`,
`debug_pine_script` i `replay_practice_session`. Każdy z nich mówi asystentowi, które narzędzia
wywołać, w jakiej kolejności i o czym zdać relację. `replay_practice_session` prowadzi sesję
ćwiczeniową na odtwarzaniu świec: asystent przechodzi przez przeszłość świeca po świecy, na każdym
kroku pyta Cię, czy otworzyłbyś pozycję długą, krótką, czy pozostał poza rynkiem, prowadzi dziennik
tych hipotetycznych transakcji po cenach odczytanych z wykresu i oblicza ich zysk lub stratę. Najpierw
sprawdza, czy trwa Twoje własne odtwarzanie, i zanim cokolwiek zmieni, pyta, co z nim zrobić; na
końcu zatrzymuje odtwarzanie, które sam uruchomił, a nigdy Twoje.

### <a id="safety"></a>Bezpieczeństwo

Narzędzia, które zmieniają Twój wykres, skrypty lub konto, ostrożnie obchodzą się z tym, co już
należy do Ciebie. Zastąpienie niezapisanego tekstu w Pine Editor (innego niż niezapisana zmiana,
którą ta sesja serwera sama tam wprowadziła), zapisanie nowej wersji skryptu, którego ta sesja nie
utworzyła, oraz usunięcie wskaźnika, który już był na Twoim wykresie, wymagają `confirm: true`, które
asystent powinien przekazać dopiero po Twojej zgodzie. To samo dotyczy usunięcia rysunku, alertu,
symbolu z listy obserwowanych lub karty, których ta sesja nie utworzyła, nie dodała lub nie otworzyła,
usunięcia wszystkich rysunków wykresu, przełączenia się z układu z niezapisanymi zmianami oraz zmiany
na układ wielu wykresów z mniejszą liczbą wykresów, niż pokazuje karta, którego następny zapis
usunąłby pozostałe. Limit planu, taki jak liczba wskaźników na wykresie, zapisanych skryptów, alertów
lub wykresów w układzie, jest sprawdzany, zanim cokolwiek zostanie dodane, i zgłaszany jako błąd
`PLAN_LIMIT` z wartością limitu; gdy limitu nie da się odczytać w Twojej wersji TradingView, narzędzie
nic nie robi i to zgłasza. Serwer nie obchodzi limitów. Narzędzia najpierw sprawdzają, co sprawiłoby,
że TradingView otworzy okno zachęcające do zmiany planu lub inne własne okno dialogowe, i zamiast tego
odmawiają, ale pozostaje kilka okien, których te testy nie są w stanie przewidzieć:
`layout_switch` może trafić na okno zmiany planu przy zapisanym układzie wielu wykresów na planie z
mniejszą liczbą wykresów, przy układzie, który serwer TradingView odrzuca jako przekraczający limit,
oraz przy układzie, który lista prowadzona przez TradingView na własny użytek oznacza jako ponad
limit, podczas gdy `layout_list` tego nie robi; `layout_new` może trafić na komunikat TradingView,
gdy ten odrzuci nowy układ już po testach; a `tab_close` może trafić na okno „Close tab?” dla strony,
która odpowiada dłużej, niż TradingView czeka na informację, czy jej układ ma niezapisane zmiany,
albo która zgłasza trwające nagrywanie. Niskopoziomowe narzędzia `ui_*` klikają i wpisują to, o co
poprosisz, więc z założenia mogą otwierać okna dialogowe TradingView. Serwer nie usuwa ani nie
zmienia nazwy żadnego skryptu.

Żadne narzędzie nie składa zleceń: odtwarzanie świec służy do ćwiczeń, a asystent przechowuje
ewentualne transakcje ćwiczeniowe w rozmowie. Zrzuty ekranu trafiają do klienta jako obrazy, a serwer
żadnego nie zapisuje na dysku. `ui_evaluate`, które uruchamia JavaScript na stronie wykresu, jest
wyłączone, chyba że uruchomisz serwer z `--allow-eval` (`TV_MCP_ALLOW_EVAL=true`).

### <a id="tool-profiles"></a>Profile narzędzi

Domyślnie serwer udostępnia wszystkie swoje 83 narzędzia (`--profile full`). Niektórzy klienci
akceptują tylko ograniczoną liczbę narzędzi (Cursor ostrzega powyżej 40). Dla nich `--profile core`
udostępnia ograniczony zestaw 40 podstawowych narzędzi, a `--profile readonly` tylko 37 narzędzi,
które odczytują dane. `--tools` przyjmuje wzorce nazw, takie jak `chart_*,data_*`, i dodatkowo zawęża
profil: narzędzie musi należeć do profilu i pasować do wzorca, więc `--profile core --tools 'pine_*'`
nadal pomija `pine_open` i `pine_save`, które nie są narzędziami podstawowymi; przy profilu domyślnym
samo `--tools` wybiera narzędzia. Niektóre opisy i wskazówki wymieniają narzędzia, które `core`
pomija, takie jak `pine_open` i `pine_save`, a których asystent nie może wywołać w profilu `core`.
Zasoby podążają za narzędziami: każdy jest udostępniany tylko razem z narzędziem, z którym dzieli
dane, na przykład `tradingview://pine/source` z `pine_get_source`, więc `--tools 'chart_*'`
udostępnia stan wykresu i nic z Pine Editor.

[Dokumentacja narzędzi](../tools.md) wymienia każde narzędzie wraz z jego parametrami wejściowymi i
profilami, do których należy.

## <a id="troubleshooting"></a>Rozwiązywanie problemów

[docs/troubleshooting.md](../troubleshooting.md) wyjaśnia każdy kod błędu i co zrobić, gdy
TradingView nie zostało znalezione, port debugowania jest zajęty, klient nie pokazuje narzędzi lub
tunel odrzuca żądanie. `npx -y tradingview-desktop-mcp doctor` to pierwsze polecenie, które warto
uruchomić.

## <a id="dashboard"></a>Panel

Serwer zawiera panel webowy, który pozwala obserwować, co robi Twój asystent, i ręcznie wypróbować
narzędzie. Nie wymaga dodatkowej instalacji: opublikowany pakiet go zawiera, a `pnpm build` wbudowuje
go w serwer kopii repozytorium.

![Strona statusu: TradingView osiągalne, wykres znaleziony i aplikacja gotowa, informacje o serwerze oraz limity planu](../images/dashboard-status.png)

### <a id="open-it"></a>Otwieranie

- **Transport HTTP:** uruchom serwer z tokenem i otwórz `http://127.0.0.1:8787/`. W tym trybie panel
  jest domyślnie włączony; `--no-dashboard` (`TV_MCP_DASHBOARD=false`) go wyłącza.

  ```sh
  TV_MCP_AUTH_TOKEN="$(openssl rand -hex 32)" npx -y tradingview-desktop-mcp --transport http
  ```

  W kopii repozytorium uruchom zamiast tego `node packages/server/dist/cli.js --transport http`.

- **Obok stdio:** klient MCP, który uruchamia serwer przez stdio, również może mieć panel. Dodaj
  `--dashboard` (`TV_MCP_DASHBOARD=true`) i `TV_MCP_AUTH_TOKEN` do jego konfiguracji. Panel nasłuchuje
  pod własnym adresem, `127.0.0.1:8787`, chyba że ustawisz `--host` i `--port`, i nie serwuje
  `/mcp`. Bez tokenu albo gdy port jest zajęty, panel pozostaje wyłączony, a serwer zapisuje w logu
  ostrzeżenie, ale serwer MCP działa dalej. Wywołania wykonywane przez klienta pojawiają się w logu
  na żywo.

Serwer przy starcie wypisuje adres panelu na stderr. Nigdy nie wypisuje tokenu.

### <a id="the-token"></a>Token

Strona prosi o token (`TV_MCP_AUTH_TOKEN`), zanim cokolwiek pokaże. Wklej go albo otwórz raz
`http://127.0.0.1:8787/#token=<token>`: strona odczytuje token z fragmentu i usuwa go z adresu, a
fragment nigdy nie jest wysyłany do serwera. Strona przechowuje token w `sessionStorage`, więc znika
on po zamknięciu karty, i wysyła go wyłącznie jako `Authorization: Bearer <token>`, nigdy w adresie
URL. Gdy serwer zrestartuje się z innym tokenem, strona zapyta ponownie. Zobacz
[SECURITY.md](../../SECURITY.md#the-dashboard).

### <a id="what-it-shows"></a>Co pokazuje

![Log na żywo: tabela wywołań narzędzi, od najnowszych, z czasem, narzędziem, źródłem, statusem i czasem trwania, a nad nią wyszukiwarka i filtry](../images/dashboard-log.png)

- **Status** pokazuje, czy TradingView jest osiągalne (i jak je uruchomić, gdy nie jest), jak działa
  serwer, limity planu i ostatnie wywołania.
- **Log** strumieniuje każde wywołanie narzędzia wykonywane przez serwer, niezależnie od tego, czy
  zlecił je klient MCP, czy panel, z filtrem po nazwie narzędzia, pauzą, czyszczeniem i szczegółami
  każdego wywołania. Po zerwaniu połączenia wyświetla „Reconnecting…” i wznawia od miejsca, w którym
  się zatrzymał. Każda otwarta karta panelu utrzymuje jeden strumień zdarzeń do serwera, a
  przeglądarka pozwala na około sześć połączeń z jednym hostem, więc przy wielu otwartych kartach
  panelu nowa może czekać na wolne połączenie: zamknij karty, których nie używasz.
- **Tools** wymienia narzędzia udostępniane przez serwer wraz z ich parametrami wejściowymi i
  pozwala uruchomić jedno ręcznie. Wynik jest pokazywany w takiej postaci, w jakiej wrócił, z długim
  JSON-em zwiniętym pod „Show all” i obrazami jako obrazami.

![Strona narzędzi: lista narzędzi z wyszukiwarką i filtrami po lewej oraz chart_get_state z opisem, informacjami i polami wejściowymi po prawej](../images/dashboard-tools.png)

Uruchomienie z panelu to prawdziwe wywołanie narzędzia. Przechodzi przez ten sam rejestr co
wywołanie MCP, więc obowiązują te same schematy, profil, reguły `confirm` i sprawdzanie limitów
planu, i pojawia się w logu. Panel prosi o potwierdzenie przed uruchomieniem każdego narzędzia, które
nie jest tylko do odczytu.

### <a id="the-api"></a>API

Strona komunikuje się z serwerem przez niewielkie API, które możesz też wywoływać za pomocą `curl` i
tokenu. Każda ścieżka wymaga `Authorization: Bearer <token>`, a serwer sprawdza `Host` i `Origin`
tak samo jak dla `/mcp`.

| Ścieżka                  | Co robi                                                                 |
| ------------------------ | ----------------------------------------------------------------------- |
| `GET /api/info`          | Wersja, transport, profil, liczba narzędzi i czas uruchomienia          |
| `GET /api/health`        | Raport stanu: czy TradingView jest osiągalne                            |
| `GET /api/tools`         | Udostępniane narzędzia wraz z ich schematami i adnotacjami              |
| `POST /api/tools/<name>` | Uruchamia narzędzie z `{"arguments": {...}}`, ze źródłem `dashboard`    |
| `GET /api/events`        | Zdarzenia server-sent wywołań narzędzi; `?limit=` ustala, ile odtworzyć |

Pliki samej strony, pod `/`, nie wymagają tokenu i nie zawierają żadnych danych.

## <a id="contributing"></a>Współtworzenie

Zobacz [CONTRIBUTING.md](../../CONTRIBUTING.md), aby poznać lokalną konfigurację, poziomy testów,
konwencje commitów i sposób przygotowania wydania, oraz [docs/testing.md](../testing.md), gdzie
znajdziesz przewodnik po testowaniu. Aby zgłosić podatność, postępuj zgodnie z
[SECURITY.md](../../SECURITY.md).

## <a id="disclaimer"></a>Zastrzeżenie

Ten projekt nie jest powiązany z TradingView, Inc., ani przez nią popierany czy sponsorowany.
TradingView jest znakiem towarowym swojego właściciela. Nic tutaj nie stanowi porady finansowej.
Narzędzia zmieniają to, co pokazuje aplikacja, i mogą sięgać do jej elementów sterujących, więc
odpowiadasz za to, co automatyzujesz, i za przestrzeganie warunków korzystania z TradingView.

## <a id="license"></a>Licencja

Udostępniony na [licencji MIT](../../LICENSE).
