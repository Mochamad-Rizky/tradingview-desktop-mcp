# tradingview-desktop-mcp

[English](../../README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Türkçe](README.tr.md) · [Русский](README.ru.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md) · [Deutsch](README.de.md) · [Español](README.es.md) · **Français** · [Українська](README.uk.md) · [Polski](README.pl.md) · [Português (Brasil)](README.pt-BR.md) · [العربية](README.ar.md) · [فارسی](README.fa.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Ελληνικά](README.el.md) · [മലയാളം](README.ml.md) · [Roman Urdu](README.ur-Latn.md) · [Română](README.ro.md)

[![npm](https://img.shields.io/npm/v/tradingview-desktop-mcp)](https://www.npmjs.com/package/tradingview-desktop-mcp)
[![CI](https://github.com/Mochamad-Rizky/tradingview-desktop-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Mochamad-Rizky/tradingview-desktop-mcp/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/Mochamad-Rizky/tradingview-desktop-mcp/graph/badge.svg)](https://codecov.io/gh/Mochamad-Rizky/tradingview-desktop-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../../LICENSE)

> Ceci est une traduction du [README en anglais](../../README.md). En cas de divergence, la version anglaise fait foi.

<p align="center">
  <a href="../media/promo.mp4"><img src="../media/teaser.gif" width="49%" alt="La vidéo de présentation : un assistant lit un graphique, trace une ligne de support, écrit un Pine Script et crée une alerte de prix"></a>
  <a href="../media/tutorial.mp4"><img src="../media/tutorial-poster.jpg" width="49%" alt="Le tutoriel d'installation : tout configurer en cinq étapes"></a>
</p>

<p align="center">
  <a href="../media/promo.mp4"><b>▶ Voir la présentation</b></a> (0:48) &nbsp;·&nbsp;
  <a href="../media/tutorial.mp4"><b>▶ Voir le tutoriel d'installation</b></a> (1:53)<br>
  <sub>Les deux vidéos utilisent un graphique fictif, pas des données de marché.</sub>
</p>

Un serveur [MCP](https://modelcontextprotocol.io) qui permet aux assistants IA de lire et de piloter
l'application TradingView Desktop sur votre propre machine. Il pilote l'application dans laquelle vous
êtes déjà connecté via le Chrome DevTools Protocol, par le port de débogage que l'application ouvre
lorsqu'elle est lancée avec `--remote-debugging-port`. Il n'automatise que l'application locale : il
ne se connecte pas à votre place, ne contourne pas les limites de votre abonnement et n'appelle pas
les serveurs de TradingView.

> **Statut : pré-1.0.** Les noms des outils et les options peuvent changer avant la 1.0. Installez le
> paquet depuis npm, comme ci-dessous, ou lancez le serveur [depuis les sources](#quick-start-from-source).
> Il a été testé sous macOS ; Windows et Linux sont pris en charge au mieux.

Le serveur propose des outils pour l'application (lancement, état de santé, découverte, état de
l'interface, limites de l'abonnement, reconnexion), des outils de graphique (état, symbole, unité de
temps, type de graphique, plage visible, défilement), des outils de données de marché (barres,
cotations, informations et recherche de symboles), des outils d'indicateurs (lister, rechercher,
ajouter, supprimer, paramètres, visibilité, valeurs), des outils Pine Script (l'éditeur et les
scripts enregistrés, la compilation, la compilation intelligente avec corrections à base de règles,
l'analyse hors ligne, la console, ainsi que les lignes, étiquettes, boîtes et tableaux que dessinent
les scripts), des outils Strategy Tester (résultats, trades, courbe de capital), des outils de dessin,
d'alertes et de listes de surveillance, des outils de mise en page, de multi-graphiques et
d'onglets, le bar replay, les captures d'écran, des outils d'interface de bas niveau (clic, survol,
saisie, touches, défilement, recherche, panneaux, plein écran et JavaScript dans la page du graphique
si vous l'autorisez) et `batch_run`, qui exécute plusieurs outils en un seul appel. Il propose aussi
des ressources (l'état de santé de l'application, l'état et les barres du graphique, le code source
Pine et le dernier résultat de compilation, le rapport de stratégie, la liste de surveillance
active), chacune avec l'outil dont elle partage les données, et cinq prompts pour les tâches
courantes. Un tableau de bord web affiche les appels en direct et exécute des outils à la main (voir
[Tableau de bord](#dashboard)).

Sommaire : [Installer en le demandant à votre app IA](#install-by-asking-your-ai-app), [Installation](#install),
[Connecter votre app IA](#connect-your-ai-app), [Clients distants et tunnels](#remote-clients-and-tunnels),
[Démarrage rapide depuis les sources](#quick-start-from-source), [Utilisation](#use-it),
[Dépannage](#troubleshooting), [Tableau de bord](#dashboard), [Contribuer](#contributing).

## <a id="install-by-asking-your-ai-app"></a>Installer en le demandant à votre app IA

Vous n'avez aucune commande à taper vous-même. Si votre app IA peut exécuter des commandes sur votre
ordinateur, comme Claude Code, Cursor, VS Code, Windsurf, Gemini CLI et Codex CLI, elle peut faire
l'installation pour vous. D'abord :

1. Installez [TradingView Desktop](https://www.tradingview.com/desktop/) et connectez-vous.
2. Installez [Node.js](https://nodejs.org) (la version LTS), si vous ne l'avez pas encore.

Copiez ensuite ce prompt, collez-le dans votre app IA et envoyez-le :

```text
Installe-moi le serveur MCP TradingView. C'est le paquet npm tradingview-desktop-mcp
(https://github.com/Mochamad-Rizky/tradingview-desktop-mcp). Suis ces étapes et explique-moi chacune
d'elles avec des mots simples :

1. Vérifie que Node.js 20.19 ou une version plus récente est installé. Sinon, arrête-toi et
   explique-moi comment l'installer.
2. Exécute "npx -y tradingview-desktop-mcp config <client>", <client> étant l'app dans laquelle tu
   t'exécutes (claude-code, cursor, vscode, windsurf, gemini-cli ou codex-cli). Fais ce qu'elle
   affiche pour ajouter le serveur à ma configuration, et conserve les autres serveurs déjà présents.
3. Lance TradingView avec "npx -y tradingview-desktop-mcp launch". Si elle indique que TradingView
   tourne déjà sans le port de débogage, demande-moi d'abord, et seulement si j'accepte relance-la
   avec --restart, car cela ferme TradingView et je risque de perdre des modifications non
   enregistrées.
4. Exécute "npx -y tradingview-desktop-mcp doctor" et dis-moi si toutes les vérifications passent.
   Si la vérification du graphique échoue, dis-moi de mettre l'onglet du graphique au premier plan
   dans TradingView.
5. Dis-moi si je dois te redémarrer, ou ouvrir une nouvelle conversation, avant que les outils
   TradingView apparaissent.
```

Une fois terminé, redémarrez l'app ou ouvrez une nouvelle conversation si elle vous l'a indiqué, puis
demandez « Vérifie que TradingView est connecté. » Essayez ensuite les
[prompts ci-dessous](#try-these-prompts).

Vous utilisez Claude Desktop ? Il ne peut pas exécuter de commandes, mais Claude Code, Cursor et les
autres apps ci-dessus peuvent le configurer pour vous : ajoutez « Configure-le pour Claude Desktop
(config claude-desktop), pas pour cette app. » à la fin du prompt. ChatGPT et l'OpenAI API ont besoin
d'un tunnel, que vous configurez à la main (voir
[Clients distants et tunnels](#remote-clients-and-tunnels)). Si l'assistant est bloqué, suivez
vous-même les étapes ci-dessous.

## <a id="install"></a>Installation

Il vous faut :

- TradingView Desktop, installé et connecté.
- Node.js 20.19 ou plus récent, qui fournit `npx`.

Rien d'autre n'est installé : les clients ci-dessous lancent le serveur avec
`npx -y tradingview-desktop-mcp`, qui télécharge le paquet à la première utilisation. Lancez
TradingView avec son port de débogage. La commande `launch` trouve l'application et la lance de
cette façon :

```sh
npx -y tradingview-desktop-mcp launch
```

TradingView n'autorise qu'une seule instance. S'il tourne déjà sans le port de débogage, `launch`
s'arrête et le signale ; `launch --restart` le ferme proprement et le relance avec le port, et
TradingView peut d'abord vous demander d'enregistrer vos modifications. Vérifiez que le serveur
atteint l'application :

```sh
npx -y tradingview-desktop-mcp doctor
```

`doctor` échoue à sa vérification du graphique tant que l'onglet du graphique est en arrière-plan,
derrière la page Nouvel onglet ou un autre onglet sans graphique : mettez donc l'onglet du graphique
au premier plan. `npx -y tradingview-desktop-mcp --help` liste les options, et
[.env.example](../../.env.example) les variables d'environnement.

## <a id="connect-your-ai-app"></a>Connecter votre app IA

`config <client>` affiche l'extrait de configuration d'un client et indique où le placer. Chaque
tutoriel ci-dessous contient le même extrait, les étapes pour cette app et la marche à suivre quand
cela ne fonctionne pas.

| Client                                         | Afficher l'extrait                                     |
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

Le transport par défaut est stdio : stdout ne transporte que des messages MCP et les logs vont sur
stderr. Les sept premiers clients lancent eux-mêmes le serveur. Sous Windows, un client qui ne peut
pas lancer `npx` directement a besoin de la forme `cmd /c npx`, que `config` affiche lorsqu'il
s'exécute sous Windows (ou avec `--platform win32`). `--profile` transmet un
[profil d'outils](#tool-profiles) au serveur.

### <a id="remote-clients-and-tunnels"></a>Clients distants et tunnels

ChatGPT et l'OpenAI API ne peuvent pas lancer de programme sur votre ordinateur. Ils atteignent le
serveur via une adresse HTTPS publique : vous le faites donc tourner en HTTP et placez un tunnel
devant. Cela expose sur Internet un serveur capable de piloter votre TradingView connecté : utilisez
`--profile readonly`, un token robuste (`TV_MCP_AUTH_TOKEN`), l'hôte public du tunnel dans
`--allowed-hosts` (`TV_MCP_ALLOWED_HOSTS`) et `--no-dashboard`, afin que les fichiers du tableau de
bord ne soient pas servis à travers le tunnel. Les tutoriels pour [ChatGPT](../clients/chatgpt.md)
et l'[OpenAI API](../clients/openai-api.md) détaillent la procédure, et
[SECURITY.md](../../SECURITY.md#tunnels-and-remote-clients) liste ce qu'un token en lecture seule peut
encore atteindre.

## <a id="quick-start-from-source"></a>Démarrage rapide depuis les sources

Pour exécuter une copie du dépôt plutôt que le paquet publié, il vous faut Node.js 24 pour compiler le
serveur (`nvm use` lit `.nvmrc`) et [pnpm](https://pnpm.io), dans la version épinglée par
`package.json`. Le serveur compilé tourne sur Node.js 20.19 ou plus récent.

```sh
git clone https://github.com/Mochamad-Rizky/tradingview-desktop-mcp.git
cd tradingview-desktop-mcp
pnpm install && pnpm build
node packages/server/dist/cli.js launch
node packages/server/dist/cli.js doctor
```

`node packages/server/dist/cli.js config <client> --local` affiche l'extrait d'un client pour cette
copie, avec `node` et le chemin absolu de `cli.js` à la place de `npx`. Pour un client configuré en
JSON, l'entrée ressemble à ceci :

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

Il existe aussi un transport HTTP (`--transport http`) ; lisez [SECURITY.md](../../SECURITY.md) avant de
l'utiliser.

## <a id="use-it"></a>Utilisation

Connectez un client MCP comme décrit ci-dessus, avec TradingView lancé avec son port de débogage, et
demandez ce que vous voulez avec des mots simples. L'assistant choisit les outils et les appelle :
vous n'avez donc pas besoin de connaître leurs noms. La [référence des outils](../tools.md) liste
chaque outil avec ses paramètres et les profils auxquels il appartient.

### <a id="try-these-prompts"></a>Essayez ces prompts

Chaque prompt ci-dessous est l'un des exemples de [docs/examples.md](../examples.md), qui montre
les appels d'outils effectués par l'assistant et leurs résultats, avec les listes de plus de trois
éléments tronquées, la durée de chaque appel (`durationMs`) omise et les captures d'écran mentionnées
dans une note au lieu d'être affichées. Les extraits sont des lignes de ces résultats, et `…` marque
l'endroit où des lignes d'autres parties d'un résultat ont été omises. Les valeurs sont synthétiques :
elles proviennent d'une fausse application TradingView avec un graphique NASDAQ:AAPL fictif, donc
rien n'est une donnée de marché et rien ne provient d'un compte ; les résultats ont la forme que leur
donne le serveur, même si le rapport du Strategy Tester derrière l'exemple de backtest n'a pas encore
été lu depuis la vraie application.

**« Qu'est-ce que je regarde sur mon graphique ? Donne-moi le symbole, l'unité de temps et les
indicateurs qui s'y trouvent. »** L'assistant lit le graphique avec `chart_get_state`
([détails](../examples.md#1-read-the-chart)) :

```json
"symbol": "NASDAQ:AAPL",
"resolution": "1D",
"chartTypeName": "candles",
```

**« Montre-moi les 3 dernières bougies journalières. »** Il lit les barres avec `data_get_ohlcv`
([détails](../examples.md#3-read-the-last-candles)) :

```json
"timeIso": "2024-10-27T00:00:00Z",
"open": 103.58,
"close": 103.42,
```

**« Ajoute le MACD à mon graphique. »** Sur un graphique qui contient déjà autant d'indicateurs que
l'abonnement le permet, `indicator_add` n'ajoute rien et signale la limite, et supprimer l'un de vos
indicateurs pour faire de la place nécessite votre confirmation
([détails](../examples.md#5-add-an-indicator-to-a-full-chart)) :

```json
"code": "PLAN_LIMIT",
"message": "The chart holds as many indicators as the plan allows (2)",
```

**« Écris un indicateur Pine Script qui trace une moyenne mobile sur 9 barres et une sur 21 barres
de la clôture, et vérifie qu'il compile. »** Il place le script dans le Pine Editor avec `pine_new`
et le compile avec `pine_compile` ([détails](../examples.md#6-write-and-compile-a-pine-script)) :

```json
"success": true,
"errors": [],
"warnings": [],
```

**« Le script dans mon Pine Editor ne compile pas. Tu peux le corriger ? »** `pine_smart_compile`
compile le script, applique des corrections à base de règles pour les erreurs qu'il connaît, comme
des noms Pine v4 dans un script v6, puis compile à nouveau, sans modifier l'éditeur
([détails](../examples.md#7-fix-a-pine-script-with-smart-compile)) :

```json
"message": "Could not find function or function reference 'study'",
…
"applied": ["Replace study( with indicator(", "Replace rsi( with ta.rsi("]
…
"writtenBack": false
```

**« Comment la stratégie de mon graphique s'est-elle comportée en backtest ? »** Il lit le Strategy
Tester avec `strategy_get_results` et `strategy_get_trades`
([détails](../examples.md#8-read-backtest-results)) :

```json
"netProfit": 155,
"totalTrades": 3,
"percentProfitable": 66.67,
"profitFactor": 4.1,
```

**« Trace une ligne de support à 102,80 sur mon graphique. »** Il trace une ligne horizontale avec
`drawing_create`, et `drawing_list` l'affiche à côté de vos propres dessins, marquée comme tracée par
cette session ([détails](../examples.md#9-draw-a-support-line)) :

```json
"id": "DRW001",
"shape": "horizontal_line",
"text": "Support",
"createdByServer": true
```

**« Préviens-moi quand Apple franchit 110. »** `alert_create` crée une alerte de prix dans votre
compte TradingView ([détails](../examples.md#10-create-a-price-alert)). Quand l'abonnement contient
déjà autant d'alertes qu'il le permet, il ne crée rien et signale la limite, et `alert_list` affiche
les alertes qui l'occupent ([détails](../examples.md#11-create-an-alert-when-the-plan-is-full)) :

```json
"symbol": "NASDAQ:AAPL",
"condition": "crossing",
"price": 110,
"expirationIso": "2024-11-26T00:00:00Z"
```

**« Ajoute ces symboles à ma liste de surveillance : NYSE:IBM, FX:EURUSD, NASDAQ:MSFT et
NASDAQ:MSTF. »** `watchlist_add_bulk` vérifie chaque symbole avec la recherche de symboles de
TradingView, ajoute les nouveaux et explique pourquoi il a ignoré les autres
([détails](../examples.md#12-add-symbols-to-a-watchlist)) :

```json
"added": ["NYSE:IBM", "FX:EURUSD"],
…
{ "symbol": "NASDAQ:MSFT", "reason": "already_listed" },
{ "symbol": "NASDAQ:MSTF", "reason": "unknown" }
```

**« Laisse-moi m'entraîner sur un bar replay de mon graphique à partir du 2024-06-03 : avance de cinq
barres, dis-moi où on en est, puis termine le replay. »** Il démarre le bar replay avec
`replay_start`, avance avec `replay_step`, lit où en est le replay avec `replay_status` et le quitte
avec `replay_stop`. Rien n'est négocié : aucun outil ne passe d'ordre
([détails](../examples.md#13-practice-with-bar-replay)) :

```json
"dateIso": "2024-06-07T00:00:00Z",
"stepped": 5,
…
"position": null,
"realizedPL": null
```

**« Fais une capture d'écran de mon graphique. »** `screenshot_capture` transmet l'image à
l'assistant en tant qu'image, avec sa taille, et n'écrit rien sur le disque
([détails](../examples.md#14-take-a-screenshot)) :

```json
"data": { "target": "chart", "format": "jpeg", "width": 1180, "height": 640, "bytes": 3100 },
"meta": { "via": "cdp", "warnings": [] }
```

Le serveur propose aussi cinq prompts qui lui sont propres, qu'un client prenant en charge les
prompts MCP vous liste pour que vous en choisissiez un : `analyze_current_chart`,
`multi_timeframe_review`, `write_and_backtest_strategy`, `debug_pine_script` et
`replay_practice_session`. Chacun indique à l'assistant quels outils appeler, dans quel ordre, et ce
qu'il doit rapporter. `replay_practice_session` mène une séance d'entraînement en bar replay :
l'assistant parcourt le passé barre par barre, vous demande à chaque étape si vous prendriez une
position longue, une position courte ou resteriez hors du marché, tient un journal de ces trades
hypothétiques aux prix qu'il lit sur le graphique, et calcule leur gain ou leur perte. Il vérifie
d'abord si un replay à vous est en cours, et vous demande quoi en faire avant de modifier quoi que ce
soit ; à la fin, il arrête le replay qu'il a lancé, et jamais l'un des vôtres.

### <a id="safety"></a>Sécurité

Les outils qui modifient votre graphique, vos scripts ou votre compte prennent soin de ce qui vous
appartient déjà. Remplacer du texte non enregistré dans le Pine Editor (sauf une modification non
enregistrée que cette session du serveur y a faite elle-même), enregistrer une nouvelle version d'un
script que cette session n'a pas créé, et supprimer un indicateur qui était déjà sur votre graphique
nécessitent tous `confirm: true`, que l'assistant ne doit transmettre qu'après votre accord. Il en va
de même pour la suppression d'un dessin, d'une alerte, d'un symbole de liste de surveillance ou d'un
onglet que cette session n'a pas créé, ajouté ou ouvert, la suppression de tous les dessins d'un
graphique, le passage depuis une mise en page comportant des modifications non enregistrées, et le
passage à une mise en page multi-graphiques avec moins de graphiques que l'onglet n'en affiche, dont
le prochain enregistrement supprimerait les autres. Une limite de l'abonnement, comme le nombre
d'indicateurs sur un graphique, de scripts enregistrés, d'alertes ou de graphiques d'une mise en page,
est vérifiée avant tout ajout et signalée par une erreur `PLAN_LIMIT` accompagnée de la limite ;
lorsque la limite ne peut pas être lue sur votre version de TradingView, l'outil ne fait rien et le
signale. Le serveur ne contourne aucune limite. Les outils vérifient d'abord ce qui amènerait
TradingView à ouvrir sa boîte de dialogue de mise à niveau, ou une autre de ses boîtes de dialogue,
et refusent dans ce cas, mais il reste quelques invites que ces vérifications ne peuvent pas
anticiper : `layout_switch` peut tomber sur une invite de mise à niveau pour une mise en page
multi-graphiques enregistrée sur un abonnement offrant moins de graphiques, pour une mise en page que
le serveur de TradingView refuse comme dépassant la limite, et pour une mise en page que la liste
tenue par TradingView pour son propre usage marque comme au-delà de la limite alors que
`layout_list` ne le fait pas ; `layout_new` peut tomber sur un message de TradingView lorsque
celui-ci refuse la nouvelle mise en page après les vérifications ; et `tab_close` peut tomber sur la
boîte de dialogue « Fermer l'onglet ? » pour une page qui met plus de temps que TradingView n'en
attend pour indiquer si sa mise en page a des modifications non enregistrées, ou qui signale un
enregistrement en cours. Les outils de bas niveau `ui_*` cliquent et saisissent ce que vous demandez,
et peuvent donc, par conception, ouvrir des boîtes de dialogue de TradingView. Le serveur ne supprime
ni ne renomme aucun script.

Aucun outil ne passe d'ordre : le bar replay sert à s'entraîner, et l'assistant conserve les trades
d'entraînement dans la conversation. Les captures d'écran sont transmises au client sous forme
d'images, et le serveur n'en écrit aucune sur le disque. `ui_evaluate`, qui exécute du JavaScript
dans la page du graphique, est désactivé sauf si vous lancez le serveur avec `--allow-eval`
(`TV_MCP_ALLOW_EVAL=true`).

### <a id="tool-profiles"></a>Profils d'outils

Par défaut, le serveur propose ses 83 outils (`--profile full`). Certains clients n'acceptent qu'un
nombre limité d'outils (Cursor avertit au-delà de 40). Pour eux, `--profile core` propose un
ensemble réduit de 40 outils essentiels, et `--profile readonly` uniquement les 37 outils de lecture.
`--tools` accepte des motifs de noms comme `chart_*,data_*` et restreint encore le profil : un outil
doit faire partie du profil et correspondre à un motif, si bien que `--profile core --tools 'pine_*'`
exclut toujours `pine_open` et `pine_save`, qui ne font pas partie des outils core ; avec le profil
par défaut, `--tools` seul choisit les outils. Certaines descriptions et indications mentionnent des
outils que `core` exclut, comme `pine_open` et `pine_save`, que l'assistant ne peut pas appeler avec
`core`. Les ressources suivent les outils : chacune n'est proposée qu'avec l'outil dont elle partage
les données, comme `tradingview://pine/source` avec `pine_get_source`, si bien que
`--tools 'chart_*'` propose l'état du graphique et rien du Pine Editor.

La [référence des outils](../tools.md) liste chaque outil avec ses paramètres et les profils
auxquels il appartient.

## <a id="troubleshooting"></a>Dépannage

[docs/troubleshooting.md](../troubleshooting.md) explique chaque code d'erreur et que faire lorsque
TradingView est introuvable, que le port de débogage est occupé, qu'un client n'affiche pas les
outils ou qu'un tunnel refuse une requête. `npx -y tradingview-desktop-mcp doctor` est la première
commande à lancer.

## <a id="dashboard"></a>Tableau de bord

Le serveur est livré avec un tableau de bord web pour observer ce que fait votre assistant et pour
essayer un outil à la main. Il ne nécessite aucune installation supplémentaire : le paquet publié
l'inclut, et `pnpm build` l'intègre au serveur d'une copie du dépôt.

![La page d'état : TradingView joignable avec un graphique trouvé et l'application prête, les informations du serveur et les limites de l'abonnement](../images/dashboard-status.png)

### <a id="open-it"></a>L'ouvrir

- **Transport HTTP :** lancez le serveur avec un token et ouvrez `http://127.0.0.1:8787/`. Le
  tableau de bord est activé par défaut dans ce mode ; `--no-dashboard` (`TV_MCP_DASHBOARD=false`)
  le désactive.

  ```sh
  TV_MCP_AUTH_TOKEN="$(openssl rand -hex 32)" npx -y tradingview-desktop-mcp --transport http
  ```

  Depuis une copie du dépôt, exécutez plutôt `node packages/server/dist/cli.js --transport http`.

- **À côté de stdio :** un client MCP qui lance le serveur via stdio peut lui aussi avoir un tableau
  de bord. Ajoutez `--dashboard` (`TV_MCP_DASHBOARD=true`) et `TV_MCP_AUTH_TOKEN` à sa
  configuration. Le tableau de bord écoute sur sa propre adresse, `127.0.0.1:8787` sauf si vous
  définissez `--host` et `--port`, et ne sert pas `/mcp`. Sans le token, ou si le port est déjà pris,
  le tableau de bord reste désactivé et le serveur journalise un avertissement, mais le serveur MCP
  continue de tourner. Les appels effectués par le client apparaissent dans le journal en direct.

Le serveur affiche l'adresse du tableau de bord sur stderr au démarrage. Il n'affiche jamais le token.

### <a id="the-token"></a>Le token

La page demande le token (`TV_MCP_AUTH_TOKEN`) avant d'afficher quoi que ce soit. Collez-le, ou
ouvrez une fois `http://127.0.0.1:8787/#token=<token>` : la page lit le token dans le fragment et le
retire de l'adresse, et le fragment n'est jamais envoyé au serveur. La page conserve le token dans
`sessionStorage`, il disparaît donc quand vous fermez l'onglet, et elle ne l'envoie que sous la forme
`Authorization: Bearer <token>`, jamais dans une URL. Quand le serveur redémarre avec un autre token,
la page le redemande. Voir [SECURITY.md](../../SECURITY.md#the-dashboard).

### <a id="what-it-shows"></a>Ce qu'il affiche

![Le journal en direct : un tableau des appels d'outils, les plus récents en premier, avec leur heure, outil, origine, statut et durée, surmonté de la recherche et des filtres](../images/dashboard-log.png)

- **Status** indique si TradingView est joignable (et comment le lancer si ce n'est pas le cas),
  comment le serveur tourne, les limites de l'abonnement et les derniers appels.
- **Log** diffuse en continu chaque appel d'outil exécuté par le serveur, qu'il provienne d'un
  client MCP ou du tableau de bord, avec un filtre par nom d'outil, pause, effacement et le détail
  de chaque appel. Après une coupure de connexion, il affiche « Reconnexion… » et reprend là où il
  s'était arrêté. Chaque onglet ouvert du tableau de bord maintient un flux d'événements vers le
  serveur, et un navigateur autorise environ six connexions vers un même hôte : avec de nombreux
  onglets du tableau de bord ouverts, un nouvel onglet peut donc attendre qu'une connexion se
  libère. Fermez les onglets dont vous ne vous servez pas.
- **Tools** liste les outils proposés par le serveur, avec leurs paramètres, et en exécute un à la
  main. Le résultat est affiché tel qu'il est revenu, avec le JSON long replié derrière « Tout
  afficher » et les images affichées comme images.

![La page des outils : à gauche la liste des outils avec sa recherche et ses filtres, à droite chart_get_state avec sa description, ses informations et ses champs de saisie](../images/dashboard-tools.png)

Une exécution depuis le tableau de bord est un véritable appel d'outil. Elle passe par le même
registre qu'un appel MCP : les mêmes schémas, le même profil, les mêmes règles `confirm` et les mêmes
vérifications des limites de l'abonnement s'appliquent donc, et elle apparaît dans le journal. Le
tableau de bord vous demande confirmation avant d'exécuter tout outil qui n'est pas en lecture seule.

### <a id="the-api"></a>L'API

La page communique avec le serveur via une petite API, que vous pouvez aussi appeler avec `curl` et
le token. Chaque route exige `Authorization: Bearer <token>`, et le serveur vérifie `Host` et
`Origin` comme il le fait pour `/mcp`.

| Route                    | Ce qu'elle fait                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `GET /api/info`          | Version, transport, profil, nombre d'outils et heure de démarrage                        |
| `GET /api/health`        | Le rapport d'état de santé : TradingView est-il joignable                                |
| `GET /api/tools`         | Les outils proposés, avec leurs schémas et annotations                                   |
| `POST /api/tools/<name>` | Exécute un outil avec `{"arguments": {...}}`, avec l'origine `dashboard`                 |
| `GET /api/events`        | Server-sent events des appels d'outils ; `?limit=` fixe combien d'entre eux sont rejoués |

Les fichiers de la page elle-même, sous `/`, ne nécessitent pas de token et ne contiennent aucune
donnée.

## <a id="contributing"></a>Contribuer

Voir [CONTRIBUTING.md](../../CONTRIBUTING.md) pour l'installation locale, les niveaux de tests, les
conventions de commit et la façon dont une version est publiée, et [docs/testing.md](../testing.md)
pour le guide des tests. Pour signaler une vulnérabilité, suivez [SECURITY.md](../../SECURITY.md).

## <a id="disclaimer"></a>Avertissement

Ce projet n'est ni affilié à TradingView, Inc., ni approuvé ou sponsorisé par celle-ci. TradingView
est une marque de son propriétaire. Rien ici ne constitue un conseil financier. Les outils modifient
ce qu'affiche l'application et peuvent accéder à ses commandes : vous êtes donc responsable de ce que
vous automatisez et du respect des conditions d'utilisation de TradingView.

## <a id="license"></a>Licence

Publié sous la [licence MIT](../../LICENSE).
