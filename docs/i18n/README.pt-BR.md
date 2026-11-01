# tradingview-desktop-mcp

[English](../../README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Türkçe](README.tr.md) · [Русский](README.ru.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Українська](README.uk.md) · [Polski](README.pl.md) · **Português (Brasil)** · [العربية](README.ar.md) · [فارسی](README.fa.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Ελληνικά](README.el.md) · [മലയാളം](README.ml.md) · [Roman Urdu](README.ur-Latn.md) · [Română](README.ro.md)

[![npm](https://img.shields.io/npm/v/tradingview-desktop-mcp)](https://www.npmjs.com/package/tradingview-desktop-mcp)
[![CI](https://github.com/Mochamad-Rizky/tradingview-desktop-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Mochamad-Rizky/tradingview-desktop-mcp/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/Mochamad-Rizky/tradingview-desktop-mcp/graph/badge.svg)](https://codecov.io/gh/Mochamad-Rizky/tradingview-desktop-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../../LICENSE)

> Esta é uma tradução do [README em inglês](../../README.md). Se as duas versões divergirem, a versão em inglês é a referência.

<p align="center">
  <a href="../media/promo.mp4"><img src="../media/teaser.gif" width="49%" alt="O vídeo de apresentação: um assistente lê um gráfico, desenha uma linha de suporte, escreve um Pine Script e cria um alerta de preço"></a>
  <a href="../media/tutorial.mp4"><img src="../media/tutorial-poster.jpg" width="49%" alt="O tutorial de configuração: configure em cinco passos"></a>
</p>

<p align="center">
  <a href="../media/promo.mp4"><b>▶ Assista à apresentação</b></a> (0:48) &nbsp;·&nbsp;
  <a href="../media/tutorial.mp4"><b>▶ Assista ao tutorial de configuração</b></a> (1:53)<br>
  <sub>Os dois vídeos usam um gráfico fictício, não dados de mercado.</sub>
</p>

Um servidor [MCP](https://modelcontextprotocol.io) que permite que assistentes de IA leiam e
controlem o aplicativo TradingView Desktop na sua própria máquina. Ele comanda o aplicativo em que
você já está logado pelo Chrome DevTools Protocol, através da porta de depuração que o aplicativo
abre quando é iniciado com `--remote-debugging-port`. Ele só automatiza o aplicativo local: não faz
login por você, não contorna limites do plano e não chama os servidores do TradingView.

> **Status: pré-1.0.** Nomes de ferramentas e opções podem mudar antes da 1.0. Instale o pacote pelo
> npm, como mostrado abaixo, ou rode o servidor [a partir do código-fonte](#quick-start-from-source).
> Ele foi testado no macOS; Windows e Linux são suportados na base do melhor esforço.

O servidor oferece ferramentas do aplicativo (inicialização, saúde, descoberta, estado da interface,
limites do plano, reconexão), ferramentas de gráfico (estado, símbolo, timeframe, tipo de gráfico,
intervalo visível, rolagem), ferramentas de dados de mercado (barras, cotações, informações e busca
de símbolos), ferramentas de indicadores (listar, buscar, adicionar, remover, entradas,
visibilidade, valores), ferramentas de Pine Script (o editor e os scripts salvos, compilação,
compilação inteligente com correções baseadas em regras, análise offline, o console e as linhas,
rótulos, caixas e tabelas que os scripts desenham), ferramentas do Strategy Tester (resultados,
operações, patrimônio), ferramentas de desenhos, alertas e watchlists, ferramentas de layout,
múltiplos gráficos e abas, bar replay, capturas de tela, ferramentas de interface de baixo nível
(clicar, passar o mouse, digitar, teclas, rolar, localizar, painéis, tela cheia e JavaScript na
página do gráfico, quando você permitir) e `batch_run`, que executa várias ferramentas em uma única
chamada. Ele também oferece recursos (a saúde do aplicativo, o estado e as barras do gráfico, o
código Pine e o último resultado de compilação, o relatório da estratégia, a watchlist ativa), cada
um junto com a ferramenta com a qual compartilha os dados, e cinco prompts para tarefas comuns. Um
painel web mostra as chamadas ao vivo e executa ferramentas manualmente (veja [Painel](#dashboard)).

Conteúdo: [Instale pedindo ao seu app de IA](#install-by-asking-your-ai-app), [Instalação](#install),
[Conecte seu app de IA](#connect-your-ai-app), [Clientes remotos e túneis](#remote-clients-and-tunnels),
[Início rápido a partir do código-fonte](#quick-start-from-source), [Como usar](#use-it),
[Solução de problemas](#troubleshooting), [Painel](#dashboard), [Como contribuir](#contributing).

## <a id="install-by-asking-your-ai-app"></a>Instale pedindo ao seu app de IA

Você não precisa digitar nenhum comando. Se o seu app de IA consegue executar comandos no seu
computador, como Claude Code, Cursor, VS Code, Windsurf, Gemini CLI e Codex CLI conseguem, ele pode
fazer a configuração para você. Primeiro:

1. Instale o [TradingView Desktop](https://www.tradingview.com/desktop/) e faça login.
2. Instale o [Node.js](https://nodejs.org) (a versão LTS), se ainda não tiver.

Depois copie este prompt, cole no seu app de IA e envie:

```text
Instale para mim o servidor TradingView MCP. É o pacote npm tradingview-desktop-mcp
(https://github.com/Mochamad-Rizky/tradingview-desktop-mcp). Siga estes passos e me explique cada um
em palavras simples:

1. Verifique se o Node.js 20.19 ou mais recente está instalado. Se não estiver, pare e me diga como instalá-lo.
2. Execute "npx -y tradingview-desktop-mcp config <client>", sendo <client> o app em que você está
   rodando (claude-code, cursor, vscode, windsurf, gemini-cli ou codex-cli). Faça o que ele mostrar
   para adicionar o servidor à minha configuração e mantenha os outros servidores que já estiverem lá.
3. Inicie o TradingView com "npx -y tradingview-desktop-mcp launch". Se ele disser que o TradingView
   já está rodando sem a porta de depuração, me pergunte primeiro e, só quando eu concordar, execute
   de novo com --restart, porque isso fecha o TradingView e posso perder alterações não salvas.
4. Execute "npx -y tradingview-desktop-mcp doctor" e me diga se todas as verificações passaram. Se a
   verificação do gráfico falhar, me diga para trazer a aba do gráfico para a frente no TradingView.
5. Me diga se preciso reiniciar você, ou abrir um novo chat, antes que as ferramentas do TradingView apareçam.
```

Quando terminar, reinicie o app ou abra um novo chat se ele tiver pedido, e pergunte "Verifique se o
TradingView está conectado." Depois experimente os [prompts abaixo](#try-these-prompts).

Usa o Claude Desktop? Ele não consegue executar comandos, mas o Claude Code, o Cursor e os outros
apps acima podem configurá-lo para você: acrescente "Configure para o Claude Desktop (config
claude-desktop), não para este app." ao final do prompt. O ChatGPT e a OpenAI API precisam de um
túnel, que você configura manualmente (veja [Clientes remotos e túneis](#remote-clients-and-tunnels)).
Se o assistente travar, siga você mesmo os passos abaixo.

## <a id="install"></a>Instalação

Você precisa de:

- TradingView Desktop, instalado e com login feito.
- Node.js 20.19 ou mais recente, que fornece o `npx`.

Nada mais é instalado: os clientes abaixo iniciam o servidor com `npx -y tradingview-desktop-mcp`,
que baixa o pacote no primeiro uso. Inicie o TradingView com a porta de depuração. O comando
`launch` encontra o aplicativo e o inicia dessa forma:

```sh
npx -y tradingview-desktop-mcp launch
```

O TradingView permite apenas uma instância. Se ele já estiver rodando sem a porta de depuração, o
`launch` para e avisa; `launch --restart` fecha o aplicativo de forma educada e o inicia de novo com
a porta, e o TradingView pode pedir que você salve as alterações antes. Verifique se o servidor
consegue alcançar o aplicativo:

```sh
npx -y tradingview-desktop-mcp doctor
```

O `doctor` falha na verificação do gráfico enquanto a aba do gráfico estiver em segundo plano, atrás
da página de nova aba ou de outra aba sem gráfico, então traga a aba do gráfico para a frente.
`npx -y tradingview-desktop-mcp --help` lista as opções, e o [.env.example](../../.env.example), as
variáveis de ambiente.

## <a id="connect-your-ai-app"></a>Conecte seu app de IA

`config <client>` mostra o trecho de configuração de um cliente e diz onde ele deve ficar. Cada
tutorial abaixo traz o mesmo trecho, os passos para aquele app e o que fazer quando não funcionar.

| Cliente                                        | Mostrar o trecho                                       |
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

O transporte padrão é stdio, em que o stdout leva apenas mensagens MCP e os logs vão para o stderr.
Os sete primeiros clientes iniciam o servidor por conta própria. No Windows, um cliente que não
consegue iniciar o `npx` diretamente precisa da forma `cmd /c npx`, que o `config` mostra quando roda
no Windows (ou com `--platform win32`). `--profile` repassa um [perfil de ferramentas](#tool-profiles)
ao servidor.

### <a id="remote-clients-and-tunnels"></a>Clientes remotos e túneis

O ChatGPT e a OpenAI API não conseguem iniciar um programa no seu computador. Eles acessam o
servidor por um endereço HTTPS público, então você o executa via HTTP e coloca um túnel na frente
dele. Isso expõe na internet um servidor capaz de controlar o seu TradingView logado: use
`--profile readonly`, um token forte (`TV_MCP_AUTH_TOKEN`), o host público do túnel em
`--allowed-hosts` (`TV_MCP_ALLOWED_HOSTS`) e `--no-dashboard`, para que os arquivos do painel não
sejam servidos pelo túnel. Os tutoriais do [ChatGPT](../clients/chatgpt.md) e da
[OpenAI API](../clients/openai-api.md) mostram o passo a passo, e o
[SECURITY.md](../../SECURITY.md#tunnels-and-remote-clients) lista o que um token somente leitura ainda
consegue alcançar.

## <a id="quick-start-from-source"></a>Início rápido a partir do código-fonte

Para rodar um checkout em vez do pacote publicado, você precisa do Node.js 24 para compilar o
servidor (`nvm use` lê o `.nvmrc`) e do [pnpm](https://pnpm.io), cuja versão é fixada no
`package.json`. O servidor compilado roda no Node.js 20.19 ou mais recente.

```sh
git clone https://github.com/Mochamad-Rizky/tradingview-desktop-mcp.git
cd tradingview-desktop-mcp
pnpm install && pnpm build
node packages/server/dist/cli.js launch
node packages/server/dist/cli.js doctor
```

`node packages/server/dist/cli.js config <client> --local` mostra o trecho de um cliente para este
checkout, com `node` e o caminho absoluto de `cli.js` no lugar de `npx`. Para um cliente com
configuração em JSON, a entrada fica assim:

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

Também existe um transporte HTTP (`--transport http`); leia o [SECURITY.md](../../SECURITY.md) antes de
usá-lo.

## <a id="use-it"></a>Como usar

Conecte um cliente MCP como descrito acima, com o TradingView rodando com a porta de depuração, e
peça o que quiser em palavras simples. O assistente escolhe as ferramentas e as chama, então você não
precisa saber os nomes delas. A [referência de ferramentas](../tools.md) lista cada ferramenta com
suas entradas e os perfis aos quais ela pertence.

### <a id="try-these-prompts"></a>Experimente estes prompts

Cada prompt abaixo é um dos exemplos em [docs/examples.md](../examples.md), que mostra as chamadas
de ferramentas que o assistente faz e os resultados, com listas de mais de três itens cortadas, a
duração de cada chamada (`durationMs`) omitida e a captura de tela mencionada em uma nota em vez de
exibida. Os trechos são linhas desses resultados, e `…` marca onde foram omitidas linhas de outras
partes de um resultado. Os valores são sintéticos: vêm de um aplicativo TradingView falso com um
gráfico fictício de NASDAQ:AAPL, então nada é dado de mercado e nada vem de uma conta; os resultados
têm o formato que o servidor lhes dá, embora o relatório do Strategy Tester por trás do exemplo de
backtest ainda não tenha sido lido do aplicativo real.

**"O que estou vendo no meu gráfico? Me diga o símbolo, o timeframe e quais indicadores estão
nele."** O assistente lê o gráfico com `chart_get_state`
([detalhes](../examples.md#1-read-the-chart)):

```json
"symbol": "NASDAQ:AAPL",
"resolution": "1D",
"chartTypeName": "candles",
```

**"Mostre os últimos 3 candles diários."** Ele lê as barras com `data_get_ohlcv`
([detalhes](../examples.md#3-read-the-last-candles)):

```json
"timeIso": "2024-10-27T00:00:00Z",
"open": 103.58,
"close": 103.42,
```

**"Adicione o MACD ao meu gráfico."** Em um gráfico que já tem tantos indicadores quanto o plano
permite, o `indicator_add` não adiciona nada e informa o limite, e remover um dos seus indicadores
para abrir espaço exige a sua confirmação
([detalhes](../examples.md#5-add-an-indicator-to-a-full-chart)):

```json
"code": "PLAN_LIMIT",
"message": "The chart holds as many indicators as the plan allows (2)",
```

**"Escreva um indicador em Pine Script que plote uma média móvel de 9 barras e outra de 21 barras do
fechamento, e verifique se ele compila."** Ele coloca o script no Pine Editor com `pine_new` e o
compila com `pine_compile` ([detalhes](../examples.md#6-write-and-compile-a-pine-script)):

```json
"success": true,
"errors": [],
"warnings": [],
```

**"O script no meu Pine Editor não compila. Você consegue corrigir?"** O `pine_smart_compile` compila
o script, aplica correções baseadas em regras para os erros que conhece, como nomes do Pine v4 em um
script v6, e compila de novo, sem alterar o editor
([detalhes](../examples.md#7-fix-a-pine-script-with-smart-compile)):

```json
"message": "Could not find function or function reference 'study'",
…
"applied": ["Replace study( with indicator(", "Replace rsi( with ta.rsi("]
…
"writtenBack": false
```

**"Como a estratégia do meu gráfico se saiu no backtest?"** Ele lê o Strategy Tester com
`strategy_get_results` e `strategy_get_trades`
([detalhes](../examples.md#8-read-backtest-results)):

```json
"netProfit": 155,
"totalTrades": 3,
"percentProfitable": 66.67,
"profitFactor": 4.1,
```

**"Desenhe uma linha de suporte em 102.80 no meu gráfico."** Ele desenha uma linha horizontal com
`drawing_create`, e o `drawing_list` a mostra ao lado dos seus próprios desenhos, marcada como
desenhada por esta sessão ([detalhes](../examples.md#9-draw-a-support-line)):

```json
"id": "DRW001",
"shape": "horizontal_line",
"text": "Support",
"createdByServer": true
```

**"Me avise quando a Apple cruzar 110."** O `alert_create` cria um alerta de preço na sua conta do
TradingView ([detalhes](../examples.md#10-create-a-price-alert)). Quando o plano já tem tantos
alertas quanto permite, ele não cria nada e informa o limite, e o `alert_list` mostra os alertas que
o ocupam ([detalhes](../examples.md#11-create-an-alert-when-the-plan-is-full)):

```json
"symbol": "NASDAQ:AAPL",
"condition": "crossing",
"price": 110,
"expirationIso": "2024-11-26T00:00:00Z"
```

**"Adicione estes símbolos à minha watchlist: NYSE:IBM, FX:EURUSD, NASDAQ:MSFT e NASDAQ:MSTF."**
O `watchlist_add_bulk` verifica cada símbolo com a busca de símbolos do TradingView, adiciona os
novos e diz por que ignorou os outros ([detalhes](../examples.md#12-add-symbols-to-a-watchlist)):

```json
"added": ["NYSE:IBM", "FX:EURUSD"],
…
{ "symbol": "NASDAQ:MSFT", "reason": "already_listed" },
{ "symbol": "NASDAQ:MSTF", "reason": "unknown" }
```

**"Quero praticar com um bar replay do meu gráfico a partir de 2024-06-03: avance cinco barras, me
diga onde estamos e depois encerre o replay."** Ele inicia o bar replay com `replay_start`, avança
com `replay_step`, lê a posição do replay com `replay_status` e sai dele com `replay_stop`. Nada é
negociado: nenhuma ferramenta envia ordens
([detalhes](../examples.md#13-practice-with-bar-replay)):

```json
"dateIso": "2024-06-07T00:00:00Z",
"stepped": 5,
…
"position": null,
"realizedPL": null
```

**"Tire uma captura de tela do meu gráfico."** O `screenshot_capture` entrega a imagem ao assistente
como imagem, junto com o tamanho dela, e não grava nada em disco
([detalhes](../examples.md#14-take-a-screenshot)):

```json
"data": { "target": "chart", "format": "jpeg", "width": 1180, "height": 640, "bytes": 3100 },
"meta": { "via": "cdp", "warnings": [] }
```

O servidor também oferece cinco prompts próprios, que um cliente com suporte a prompts MCP lista
para você escolher: `analyze_current_chart`, `multi_timeframe_review`,
`write_and_backtest_strategy`, `debug_pine_script` e `replay_practice_session`. Cada um diz ao
assistente quais ferramentas chamar, em que ordem e o que relatar. O `replay_practice_session`
conduz uma sessão de prática no bar replay: o assistente percorre o passado barra a barra, pergunta
a cada passo se você entraria comprado, vendido ou ficaria de fora, mantém um diário dessas operações
hipotéticas com preços que lê do gráfico e calcula o lucro ou prejuízo delas. Primeiro ele verifica
se há um replay seu em andamento e pergunta o que fazer com ele antes de mudar qualquer coisa; no
final, encerra o replay que ele mesmo iniciou, e nunca um dos seus.

### <a id="safety"></a>Segurança

As ferramentas que alteram o seu gráfico, os seus scripts ou a sua conta tomam cuidado com o que já
é seu. Substituir texto não salvo no Pine Editor (exceto uma edição não salva que esta sessão do
servidor tenha feito ali), salvar uma nova versão de um script que esta sessão não criou e remover
um indicador que já estava no seu gráfico exigem `confirm: true`, que o assistente só deve passar
depois que você concordar. O mesmo vale para remover um desenho, alerta, símbolo de watchlist ou aba
que esta sessão não criou, adicionou ou abriu, remover todos os desenhos de um gráfico, sair de um
layout com alterações não salvas e mudar para um layout de múltiplos gráficos com menos gráficos do
que a aba mostra, cujo próximo salvamento descartaria os outros. Um limite do plano, como o número de
indicadores em um gráfico, de scripts salvos, de alertas ou de gráficos em um layout, é verificado
antes de qualquer coisa ser adicionada e informado como um erro `PLAN_LIMIT` com o limite; quando o
limite não pode ser lido na sua versão do TradingView, a ferramenta não faz nada e avisa. O servidor
não contorna nenhum limite. As ferramentas verificam antes o que faria o TradingView abrir a janela
de upgrade, ou outra janela própria, e se recusam em vez disso, mas restam alguns avisos que essas
verificações não conseguem prever:
o `layout_switch` pode esbarrar em um aviso de upgrade para um layout salvo de múltiplos gráficos em
um plano com menos gráficos, para um layout que o servidor do TradingView recusa por exceder o
limite, e para um que a lista que o TradingView mantém para si marca como acima do limite enquanto o
`layout_list` não marca; o `layout_new` pode esbarrar em uma mensagem do TradingView quando ele recusa
o novo layout depois das verificações; e o `tab_close` pode esbarrar na janela "Close tab?" para uma
página que demora mais do que o TradingView espera para dizer se o layout dela tem alterações não
salvas, ou que informa uma gravação em andamento. As ferramentas de baixo nível `ui_*` clicam e
digitam o que você pedir, então podem abrir janelas do TradingView por design. O servidor não exclui
nem renomeia nenhum script.

Nenhuma ferramenta envia ordens: o bar replay serve para praticar, e o assistente mantém as
operações de prática na conversa. As capturas de tela vão para o cliente como imagens, e o servidor
não grava nenhuma em disco. O `ui_evaluate`, que executa JavaScript na página do gráfico, fica
desativado, a menos que você inicie o servidor com `--allow-eval` (`TV_MCP_ALLOW_EVAL=true`).

### <a id="tool-profiles"></a>Perfis de ferramentas

Por padrão, o servidor oferece todas as suas 83 ferramentas (`--profile full`). Alguns clientes
aceitam só um número limitado de ferramentas (o Cursor avisa acima de 40). Para eles,
`--profile core` oferece um conjunto reduzido de 40 ferramentas essenciais, e `--profile readonly`
oferece apenas as 37 ferramentas de leitura. `--tools` aceita padrões de nome como `chart_*,data_*`
e restringe ainda mais o perfil: uma ferramenta precisa estar no perfil e corresponder a um padrão,
então `--profile core --tools 'pine_*'` ainda deixa de fora `pine_open` e `pine_save`, que não são
ferramentas core; com o perfil padrão, `--tools` sozinho escolhe as ferramentas. Algumas descrições
e dicas citam ferramentas que o `core` deixa de fora, como `pine_open` e `pine_save`, que o
assistente não pode chamar no `core`. Os recursos acompanham as ferramentas: cada um só é oferecido
junto com a ferramenta com a qual compartilha os dados, como `tradingview://pine/source` com
`pine_get_source`, então `--tools 'chart_*'` oferece o estado do gráfico e nada do Pine Editor.

A [referência de ferramentas](../tools.md) lista cada ferramenta com suas entradas e os perfis aos
quais ela pertence.

## <a id="troubleshooting"></a>Solução de problemas

O [docs/troubleshooting.md](../troubleshooting.md) explica cada código de erro e o que fazer
quando o TradingView não é encontrado, a porta de depuração está ocupada, um cliente não mostra as
ferramentas ou um túnel recusa uma requisição. `npx -y tradingview-desktop-mcp doctor` é a primeira
coisa a executar.

## <a id="dashboard"></a>Painel

O servidor vem com um painel web para acompanhar o que o seu assistente faz e para testar uma
ferramenta manualmente. Não precisa de instalação extra: o pacote publicado já o inclui, e o
`pnpm build` o compila dentro do servidor de um checkout.

![A página de status: TradingView acessível, com um gráfico encontrado e o aplicativo pronto, os dados do servidor e os limites do plano](../images/dashboard-status.png)

### <a id="open-it"></a>Como abrir

- **Transporte HTTP:** inicie o servidor com um token e abra `http://127.0.0.1:8787/`. O painel fica
  ativado por padrão nesse modo; `--no-dashboard` (`TV_MCP_DASHBOARD=false`) o desativa.

  ```sh
  TV_MCP_AUTH_TOKEN="$(openssl rand -hex 32)" npx -y tradingview-desktop-mcp --transport http
  ```

  A partir de um checkout, execute `node packages/server/dist/cli.js --transport http` em vez disso.

- **Junto com o stdio:** um cliente MCP que inicia o servidor via stdio também pode ter um painel.
  Adicione `--dashboard` (`TV_MCP_DASHBOARD=true`) e `TV_MCP_AUTH_TOKEN` à configuração dele. O
  painel escuta em um endereço próprio, `127.0.0.1:8787`, a menos que você defina `--host` e
  `--port`, e não serve `/mcp`. Sem o token, ou quando a porta está ocupada, o painel fica desativado
  e o servidor registra um aviso, mas o servidor MCP continua rodando. As chamadas que o cliente faz
  aparecem no log ao vivo.

O servidor mostra o endereço do painel no stderr quando inicia. Ele nunca mostra o token.

### <a id="the-token"></a>O token

A página pede o token (`TV_MCP_AUTH_TOKEN`) antes de mostrar qualquer coisa. Cole-o, ou abra
`http://127.0.0.1:8787/#token=<token>` uma vez: a página lê o token do fragmento e o remove do
endereço, e o fragmento nunca é enviado ao servidor. A página guarda o token no `sessionStorage`,
então ele some quando você fecha a aba, e o envia apenas como `Authorization: Bearer <token>`, nunca
em uma URL. Quando o servidor reinicia com outro token, a página pede de novo. Veja
[SECURITY.md](../../SECURITY.md#the-dashboard).

### <a id="what-it-shows"></a>O que ele mostra

![O log ao vivo: uma tabela de chamadas de ferramentas, das mais recentes para as mais antigas, com horário, ferramenta, origem, status e duração, e a busca e os filtros acima dela](../images/dashboard-log.png)

- **Status** mostra se o TradingView está acessível (e como iniciá-lo quando não está), como o
  servidor está rodando, os limites do plano e as chamadas mais recentes.
- **Log** transmite cada chamada de ferramenta que o servidor executa, seja feita por um cliente MCP
  ou pelo painel, com filtro por nome de ferramenta, pausa, limpeza e os detalhes de cada chamada.
  Depois de uma queda de conexão, ele mostra "Reconnecting…" e retoma de onde parou. Cada aba aberta
  do painel mantém um fluxo de eventos com o servidor, e um navegador permite cerca de seis conexões
  com um mesmo host, então, com muitas abas do painel abertas, uma nova pode ficar esperando uma
  conexão livre: feche as abas que você não estiver usando.
- **Tools** lista as ferramentas que o servidor oferece, com suas entradas, e executa uma
  manualmente. O resultado é mostrado como voltou, com JSON longo recolhido atrás de "Show all" e
  imagens como imagens.

![A página de ferramentas: a lista de ferramentas com busca e filtros à esquerda, e chart_get_state com sua descrição, dados e campos de entrada à direita](../images/dashboard-tools.png)

Uma execução pelo painel é uma chamada de ferramenta real. Ela passa pelo mesmo registro que uma
chamada MCP, então os mesmos schemas, perfil, regras de `confirm` e verificações de limite do plano
se aplicam, e ela aparece no log. O painel pede confirmação antes de executar qualquer ferramenta
que não seja somente leitura.

### <a id="the-api"></a>A API

A página conversa com o servidor por uma pequena API, que você também pode chamar com `curl` e o
token. Toda rota exige `Authorization: Bearer <token>`, e o servidor verifica `Host` e `Origin` como
faz para `/mcp`.

| Rota                     | O que faz                                                                         |
| ------------------------ | --------------------------------------------------------------------------------- |
| `GET /api/info`          | Versão, transporte, perfil, número de ferramentas e horário de início             |
| `GET /api/health`        | O relatório de saúde: se o TradingView está acessível                             |
| `GET /api/tools`         | As ferramentas oferecidas, com seus schemas e anotações                           |
| `POST /api/tools/<name>` | Executa uma ferramenta com `{"arguments": {...}}`, com a origem `dashboard`       |
| `GET /api/events`        | Server-sent events das chamadas de ferramentas; `?limit=` define quantas repassar |

Os arquivos da própria página, em `/`, não precisam de token e não contêm dados.

## <a id="contributing"></a>Como contribuir

Veja o [CONTRIBUTING.md](../../CONTRIBUTING.md) para a configuração local, os níveis de teste, as
convenções de commit e como uma release é feita, e o [docs/testing.md](../testing.md) para o guia
de testes. Para relatar uma vulnerabilidade, siga o [SECURITY.md](../../SECURITY.md).

## <a id="disclaimer"></a>Aviso legal

Este projeto não é afiliado, endossado nem patrocinado pela TradingView, Inc. TradingView é uma
marca registrada de seu proprietário. Nada aqui é recomendação financeira. As ferramentas alteram o
que o aplicativo mostra e podem acessar os controles dele, então você é responsável pelo que
automatiza e por seguir os termos de uso do TradingView.

## <a id="license"></a>Licença

Distribuído sob a [licença MIT](../../LICENSE).
