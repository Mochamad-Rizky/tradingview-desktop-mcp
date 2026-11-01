# tradingview-desktop-mcp

[English](../../README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Türkçe](README.tr.md) · [Русский](README.ru.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md) · [Deutsch](README.de.md) · **Español** · [Français](README.fr.md) · [Українська](README.uk.md) · [Polski](README.pl.md) · [Português (Brasil)](README.pt-BR.md) · [العربية](README.ar.md) · [فارسی](README.fa.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Ελληνικά](README.el.md) · [മലയാളം](README.ml.md) · [Roman Urdu](README.ur-Latn.md) · [Română](README.ro.md)

[![npm](https://img.shields.io/npm/v/tradingview-desktop-mcp)](https://www.npmjs.com/package/tradingview-desktop-mcp)
[![CI](https://github.com/Mochamad-Rizky/tradingview-desktop-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Mochamad-Rizky/tradingview-desktop-mcp/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/Mochamad-Rizky/tradingview-desktop-mcp/graph/badge.svg)](https://codecov.io/gh/Mochamad-Rizky/tradingview-desktop-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../../LICENSE)

> Esta es una traducción del [README en inglés](../../README.md). Si ambos difieren, la versión en inglés es la de referencia.

<p align="center">
  <a href="../media/promo.mp4"><img src="../media/teaser.gif" width="49%" alt="El vídeo de presentación: un asistente lee un gráfico, traza una línea de soporte, escribe un Pine Script y crea una alerta de precio"></a>
  <a href="../media/tutorial.mp4"><img src="../media/tutorial-poster.jpg" width="49%" alt="El tutorial de configuración: todo listo en cinco pasos"></a>
</p>

<p align="center">
  <a href="../media/promo.mp4"><b>▶ Ver la presentación</b></a> (0:48) &nbsp;·&nbsp;
  <a href="../media/tutorial.mp4"><b>▶ Ver el tutorial de configuración</b></a> (1:53)<br>
  <sub>Ambos vídeos usan un gráfico inventado, no datos de mercado.</sub>
</p>

Un servidor [MCP](https://modelcontextprotocol.io) que permite a los asistentes de IA leer y
controlar la aplicación TradingView Desktop en tu propio equipo. Maneja la aplicación en la que ya
has iniciado sesión mediante el Chrome DevTools Protocol, a través del puerto de depuración que la
aplicación abre cuando se inicia con `--remote-debugging-port`. Solo automatiza la aplicación local:
no inicia sesión por ti, no sortea los límites del plan ni llama a los servidores de TradingView.

> **Estado: anterior a 1.0.** Los nombres de las herramientas y las opciones pueden cambiar antes de
> la 1.0. Instala el paquete desde npm, como se indica abajo, o ejecuta el servidor
> [desde el código fuente](#quick-start-from-source). Se ha probado en macOS; Windows y Linux se
> soportan en la medida de lo posible.

El servidor ofrece herramientas de la aplicación (inicio, estado, detección, estado de la interfaz,
límites del plan, reconexión), herramientas de gráfico (estado, símbolo, temporalidad, tipo de
gráfico, rango visible, desplazamiento), herramientas de datos de mercado (barras, cotizaciones,
información y búsqueda de símbolos), herramientas de indicadores (listar, buscar, añadir, quitar,
parámetros, visibilidad, valores), herramientas de Pine Script (el editor y los scripts guardados,
compilación, compilación inteligente con correcciones basadas en reglas, análisis sin conexión, la
consola, y las líneas, etiquetas, cajas y tablas que dibujan los scripts), herramientas del Strategy
Tester (resultados, operaciones, curva de capital), herramientas de dibujo, alertas y listas de
seguimiento, herramientas de diseños, multigráfico y pestañas, bar replay, capturas de pantalla,
herramientas de bajo nivel para la interfaz (clic, pasar el cursor, escribir, teclas, desplazamiento,
búsqueda, paneles, pantalla completa y JavaScript en la página del gráfico si lo permites) y
`batch_run`, que ejecuta varias herramientas en una sola llamada. También ofrece recursos (el estado
de la aplicación, el estado y las barras del gráfico, el código Pine y el último resultado de
compilación, el informe de la estrategia, la lista de seguimiento activa), cada uno junto con la
herramienta con la que comparte sus datos, y cinco prompts para tareas habituales. Un panel web
muestra las llamadas en directo y ejecuta herramientas a mano (consulta [Panel](#dashboard)).

Contenido: [Instalar pidiéndoselo a tu app de IA](#install-by-asking-your-ai-app), [Instalación](#install),
[Conectar tu app de IA](#connect-your-ai-app), [Clientes remotos y túneles](#remote-clients-and-tunnels),
[Inicio rápido desde el código fuente](#quick-start-from-source), [Uso](#use-it),
[Solución de problemas](#troubleshooting), [Panel](#dashboard), [Contribuir](#contributing).

## <a id="install-by-asking-your-ai-app"></a>Instalar pidiéndoselo a tu app de IA

No tienes que escribir ningún comando tú mismo. Si tu app de IA puede ejecutar comandos en tu
ordenador, como Claude Code, Cursor, VS Code, Windsurf, Gemini CLI y Codex CLI, puede hacer la
configuración por ti. Primero:

1. Instala [TradingView Desktop](https://www.tradingview.com/desktop/) e inicia sesión.
2. Instala [Node.js](https://nodejs.org) (la versión LTS), si aún no lo tienes.

Después copia este prompt, pégalo en tu app de IA y envíalo:

```text
Instálame el servidor MCP de TradingView. Es el paquete npm tradingview-desktop-mcp
(https://github.com/Mochamad-Rizky/tradingview-desktop-mcp). Sigue estos pasos y explícame cada uno
con palabras sencillas:

1. Comprueba que esté instalado Node.js 20.19 o posterior. Si no lo está, detente y dime cómo
   instalarlo.
2. Ejecuta "npx -y tradingview-desktop-mcp config <client>", donde <client> es la app en la que te
   estás ejecutando (claude-code, cursor, vscode, windsurf, gemini-cli o codex-cli). Haz lo que
   indique para añadir el servidor a mi configuración y conserva los demás servidores que ya haya.
3. Inicia TradingView con "npx -y tradingview-desktop-mcp launch". Si dice que TradingView ya se
   está ejecutando sin el puerto de depuración, pregúntame primero y, solo si estoy de acuerdo,
   vuelve a ejecutarlo con --restart, porque eso cierra TradingView y podría perder cambios sin
   guardar.
4. Ejecuta "npx -y tradingview-desktop-mcp doctor" y dime si se superan todas las comprobaciones. Si
   falla la comprobación del gráfico, dime que traiga al frente la pestaña del gráfico en
   TradingView.
5. Dime si tengo que reiniciarte, o abrir un chat nuevo, antes de que aparezcan las herramientas de
   TradingView.
```

Cuando termine, reinicia la app o abre un chat nuevo si te lo indicó, y pregunta «Comprueba que
TradingView está conectado.». Después prueba los [prompts de abajo](#try-these-prompts).

¿Usas Claude Desktop? No puede ejecutar comandos, pero Claude Code, Cursor y las demás apps de arriba
pueden configurarlo por ti: añade «Configúralo para Claude Desktop (config claude-desktop), no para
esta app.» al final del prompt. ChatGPT y la OpenAI API necesitan un túnel, que se configura a mano
(consulta [Clientes remotos y túneles](#remote-clients-and-tunnels)). Si el asistente se atasca, sigue
tú mismo los pasos de abajo.

## <a id="install"></a>Instalación

Necesitas:

- TradingView Desktop, instalado y con la sesión iniciada.
- Node.js 20.19 o posterior, que incluye `npx`.

No se instala nada más: los clientes de abajo inician el servidor con
`npx -y tradingview-desktop-mcp`, que descarga el paquete la primera vez que se usa. Inicia
TradingView con su puerto de depuración. El comando `launch` encuentra la aplicación y la inicia de
esa manera:

```sh
npx -y tradingview-desktop-mcp launch
```

TradingView solo permite una instancia. Si ya se está ejecutando sin el puerto de depuración,
`launch` se detiene y lo indica; `launch --restart` lo cierra de forma ordenada y lo vuelve a iniciar
con el puerto, y puede que TradingView te pida antes guardar los cambios. Comprueba que el servidor
llega a la aplicación:

```sh
npx -y tradingview-desktop-mcp doctor
```

`doctor` falla en la comprobación del gráfico mientras la pestaña del gráfico está en segundo plano,
detrás de la página Nueva pestaña o de otra pestaña sin gráfico, así que trae al frente la pestaña
del gráfico. `npx -y tradingview-desktop-mcp --help` muestra las opciones, y
[.env.example](../../.env.example) las variables de entorno.

## <a id="connect-your-ai-app"></a>Conectar tu app de IA

`config <client>` imprime el fragmento de configuración de un cliente e indica dónde va. Cada
tutorial de abajo contiene el mismo fragmento, los pasos para esa app y qué hacer cuando no funciona.

| Cliente                                        | Imprimir el fragmento                                  |
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

El transporte por defecto es stdio, en el que stdout transporta solo mensajes MCP y los logs van a
stderr. Los siete primeros clientes inician el servidor por sí mismos. En Windows, un cliente que no
puede iniciar `npx` directamente necesita la forma `cmd /c npx`, que `config` imprime cuando se
ejecuta en Windows (o con `--platform win32`). `--profile` pasa un
[perfil de herramientas](#tool-profiles) al servidor.

### <a id="remote-clients-and-tunnels"></a>Clientes remotos y túneles

ChatGPT y la OpenAI API no pueden iniciar un programa en tu ordenador. Llegan al servidor a través de
una dirección HTTPS pública, así que lo ejecutas sobre HTTP y pones un túnel delante. Eso expone en
internet un servidor capaz de controlar tu TradingView con la sesión iniciada: usa
`--profile readonly`, un token robusto (`TV_MCP_AUTH_TOKEN`), el host público del túnel en
`--allowed-hosts` (`TV_MCP_ALLOWED_HOSTS`) y `--no-dashboard`, para que los archivos del panel no se
sirvan a través del túnel. Los tutoriales de [ChatGPT](../clients/chatgpt.md) y de la
[OpenAI API](../clients/openai-api.md) lo explican paso a paso, y
[SECURITY.md](../../SECURITY.md#tunnels-and-remote-clients) enumera lo que un token de solo lectura todavía
puede alcanzar.

## <a id="quick-start-from-source"></a>Inicio rápido desde el código fuente

Para ejecutar una copia del repositorio en lugar del paquete publicado, necesitas Node.js 24 para
compilar el servidor (`nvm use` lee `.nvmrc`) y [pnpm](https://pnpm.io), en la versión que fija
`package.json`. El servidor compilado se ejecuta en Node.js 20.19 o posterior.

```sh
git clone https://github.com/Mochamad-Rizky/tradingview-desktop-mcp.git
cd tradingview-desktop-mcp
pnpm install && pnpm build
node packages/server/dist/cli.js launch
node packages/server/dist/cli.js doctor
```

`node packages/server/dist/cli.js config <client> --local` imprime el fragmento de un cliente para
esta copia, con `node` y la ruta absoluta de `cli.js` en lugar de `npx`. Para un cliente con
configuración JSON, la entrada tiene este aspecto:

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

También hay un transporte HTTP (`--transport http`); lee [SECURITY.md](../../SECURITY.md) antes de usarlo.

## <a id="use-it"></a>Uso

Conecta un cliente MCP como se describe arriba, con TradingView ejecutándose con su puerto de
depuración, y pide lo que quieras con palabras normales. El asistente elige las herramientas y las
llama, así que no necesitas conocer sus nombres. La [referencia de herramientas](../tools.md)
enumera cada herramienta con sus parámetros y los perfiles a los que pertenece.

### <a id="try-these-prompts"></a>Prueba estos prompts

Cada prompt de abajo es uno de los ejemplos de [docs/examples.md](../examples.md), que muestra las
llamadas a herramientas que hace el asistente y sus resultados, con las listas de más de tres
elementos recortadas, la duración de cada llamada (`durationMs`) omitida y las capturas de pantalla
mencionadas en una nota en lugar de mostradas. Los extractos son líneas de esos resultados, y `…`
marca dónde se han omitido líneas de otras partes de un resultado. Los valores son sintéticos:
proceden de una aplicación TradingView simulada con un gráfico NASDAQ:AAPL inventado, así que nada es
dato de mercado y nada procede de una cuenta; los resultados tienen la forma que les da el servidor,
aunque el informe del Strategy Tester del ejemplo de backtest todavía no se ha leído de la aplicación
real.

**«¿Qué estoy viendo en mi gráfico? Dime el símbolo, la temporalidad y qué indicadores tiene.»** El
asistente lee el gráfico con `chart_get_state`
([detalles](../examples.md#1-read-the-chart)):

```json
"symbol": "NASDAQ:AAPL",
"resolution": "1D",
"chartTypeName": "candles",
```

**«Muéstrame las 3 últimas velas diarias.»** Lee las barras con `data_get_ohlcv`
([detalles](../examples.md#3-read-the-last-candles)):

```json
"timeIso": "2024-10-27T00:00:00Z",
"open": 103.58,
"close": 103.42,
```

**«Añade el MACD a mi gráfico.»** En un gráfico que ya tiene tantos indicadores como permite el plan,
`indicator_add` no añade nada e informa del límite, y quitar uno de tus indicadores para hacer sitio
requiere tu confirmación ([detalles](../examples.md#5-add-an-indicator-to-a-full-chart)):

```json
"code": "PLAN_LIMIT",
"message": "The chart holds as many indicators as the plan allows (2)",
```

**«Escribe un indicador en Pine Script que dibuje una media móvil de 9 barras y otra de 21 barras del
cierre, y comprueba que compila.»** Coloca el script en el Pine Editor con `pine_new` y lo compila
con `pine_compile` ([detalles](../examples.md#6-write-and-compile-a-pine-script)):

```json
"success": true,
"errors": [],
"warnings": [],
```

**«El script de mi Pine Editor no compila. ¿Puedes arreglarlo?»** `pine_smart_compile` compila el
script, aplica correcciones basadas en reglas para los errores que conoce, como nombres de Pine v4
en un script v6, y vuelve a compilar, sin modificar el editor
([detalles](../examples.md#7-fix-a-pine-script-with-smart-compile)):

```json
"message": "Could not find function or function reference 'study'",
…
"applied": ["Replace study( with indicator(", "Replace rsi( with ta.rsi("]
…
"writtenBack": false
```

**«¿Qué tal le fue en el backtest a la estrategia de mi gráfico?»** Lee el Strategy Tester con
`strategy_get_results` y `strategy_get_trades`
([detalles](../examples.md#8-read-backtest-results)):

```json
"netProfit": 155,
"totalTrades": 3,
"percentProfitable": 66.67,
"profitFactor": 4.1,
```

**«Traza una línea de soporte en 102,80 en mi gráfico.»** Dibuja una línea horizontal con
`drawing_create`, y `drawing_list` la muestra junto a tus propios dibujos, marcada como dibujada por
esta sesión ([detalles](../examples.md#9-draw-a-support-line)):

```json
"id": "DRW001",
"shape": "horizontal_line",
"text": "Support",
"createdByServer": true
```

**«Avísame cuando Apple cruce los 110.»** `alert_create` crea una alerta de precio en tu cuenta de
TradingView ([detalles](../examples.md#10-create-a-price-alert)). Cuando el plan ya tiene tantas
alertas como permite, no crea nada e informa del límite, y `alert_list` muestra las alertas que lo
ocupan ([detalles](../examples.md#11-create-an-alert-when-the-plan-is-full)):

```json
"symbol": "NASDAQ:AAPL",
"condition": "crossing",
"price": 110,
"expirationIso": "2024-11-26T00:00:00Z"
```

**«Añade estos símbolos a mi lista de seguimiento: NYSE:IBM, FX:EURUSD, NASDAQ:MSFT y NASDAQ:MSTF.»**
`watchlist_add_bulk` comprueba cada símbolo con el buscador de símbolos de TradingView, añade los
nuevos e indica por qué omitió los demás ([detalles](../examples.md#12-add-symbols-to-a-watchlist)):

```json
"added": ["NYSE:IBM", "FX:EURUSD"],
…
{ "symbol": "NASDAQ:MSFT", "reason": "already_listed" },
{ "symbol": "NASDAQ:MSTF", "reason": "unknown" }
```

**«Déjame practicar con un bar replay de mi gráfico desde el 2024-06-03: avanza cinco barras, dime
dónde estamos y después termina el replay.»** Inicia el bar replay con `replay_start`, avanza con
`replay_step`, lee en qué punto está el replay con `replay_status` y sale de él con `replay_stop`.
No se opera nada: ninguna herramienta envía órdenes
([detalles](../examples.md#13-practice-with-bar-replay)):

```json
"dateIso": "2024-06-07T00:00:00Z",
"stepped": 5,
…
"position": null,
"realizedPL": null
```

**«Haz una captura de pantalla de mi gráfico.»** `screenshot_capture` entrega la imagen al asistente
como imagen, junto con su tamaño, y no escribe nada en disco
([detalles](../examples.md#14-take-a-screenshot)):

```json
"data": { "target": "chart", "format": "jpeg", "width": 1180, "height": 640, "bytes": 3100 },
"meta": { "via": "cdp", "warnings": [] }
```

El servidor también ofrece cinco prompts propios, que un cliente compatible con los prompts de MCP
muestra para que elijas: `analyze_current_chart`, `multi_timeframe_review`,
`write_and_backtest_strategy`, `debug_pine_script` y `replay_practice_session`. Cada uno le indica al
asistente qué herramientas llamar, en qué orden y qué debe informar. `replay_practice_session` dirige
una sesión de práctica en bar replay: el asistente recorre el pasado barra a barra, te pregunta en
cada paso si entrarías largo, corto o te quedarías fuera, lleva un diario de esas operaciones
hipotéticas a precios que lee del gráfico y calcula sus ganancias o pérdidas. Primero comprueba si
hay un replay tuyo en marcha y te pregunta qué hacer con él antes de cambiar nada; al final detiene el
replay que inició él, y nunca uno de los tuyos.

### <a id="safety"></a>Seguridad

Las herramientas que modifican tu gráfico, tus scripts o tu cuenta tienen cuidado con lo que ya es
tuyo. Sustituir texto sin guardar en el Pine Editor (salvo una edición sin guardar que esta sesión del
servidor hizo allí), guardar una nueva versión de un script que esta sesión no creó y quitar un
indicador que ya estaba en tu gráfico requieren `confirm: true`, que el asistente solo debe pasar
después de que lo aceptes. Lo mismo ocurre al quitar un dibujo, una alerta, un símbolo de una lista
de seguimiento o una pestaña que esta sesión no creó, añadió ni abrió, al quitar todos los dibujos de
un gráfico, al salir de un diseño con cambios sin guardar y al cambiar a un diseño multigráfico con
menos gráficos de los que muestra la pestaña, cuyo siguiente guardado eliminaría los demás. Un límite
del plan, como el número de indicadores de un gráfico, de scripts guardados, de alertas o de gráficos
de un diseño, se comprueba antes de añadir nada y se notifica como un error `PLAN_LIMIT` con el
límite; cuando el límite no se puede leer en tu versión de TradingView, la herramienta no hace nada y
lo indica. El servidor no sortea ningún límite. Las herramientas comprueban primero qué haría que
TradingView abriera su diálogo de mejora de plan, u otro diálogo propio, y en ese caso se niegan, pero
quedan algunos avisos que estas comprobaciones no pueden prever: `layout_switch` puede encontrarse con
un aviso de mejora de plan para un diseño multigráfico guardado en un plan con menos gráficos, para un
diseño que el servidor de TradingView rechaza por superar el límite y para uno que la lista que
TradingView mantiene para sí marca como por encima del límite mientras que `layout_list` no;
`layout_new` puede encontrarse con un mensaje de TradingView cuando este rechaza el nuevo diseño
después de las comprobaciones; y `tab_close` puede encontrarse con el diálogo «¿Cerrar pestaña?» en
una página que tarda más de lo que TradingView espera en indicar si su diseño tiene cambios sin
guardar, o que informa de una grabación en curso. Las herramientas de bajo nivel `ui_*` hacen clic y
escriben lo que les pidas, así que por diseño pueden abrir diálogos de TradingView. El servidor no
elimina ni renombra ningún script.

Ninguna herramienta envía órdenes: el bar replay es para practicar, y el asistente lleva las
operaciones de práctica en la conversación. Las capturas de pantalla llegan al cliente como imágenes,
y el servidor no escribe ninguna en disco. `ui_evaluate`, que ejecuta JavaScript en la página del
gráfico, está desactivada a menos que inicies el servidor con `--allow-eval`
(`TV_MCP_ALLOW_EVAL=true`).

### <a id="tool-profiles"></a>Perfiles de herramientas

Por defecto, el servidor ofrece sus 83 herramientas (`--profile full`). Algunos clientes solo aceptan
un número limitado de herramientas (Cursor avisa a partir de 40). Para ellos, `--profile core` ofrece
un conjunto reducido de 40 herramientas esenciales, y `--profile readonly` ofrece solo las 37
herramientas de lectura. `--tools` acepta patrones de nombre como `chart_*,data_*` y restringe aún
más el perfil: una herramienta tiene que estar en el perfil y coincidir con un patrón, así que
`--profile core --tools 'pine_*'` sigue dejando fuera `pine_open` y `pine_save`, que no son
herramientas de core; con el perfil por defecto, `--tools` por sí solo elige las herramientas.
Algunas descripciones y sugerencias mencionan herramientas que `core` deja fuera, como `pine_open` y
`pine_save`, que el asistente no puede llamar con `core`. Los recursos siguen a las herramientas: cada
uno se ofrece solo junto con la herramienta con la que comparte sus datos, como
`tradingview://pine/source` con `pine_get_source`, de modo que `--tools 'chart_*'` ofrece el estado
del gráfico y nada del Pine Editor.

La [referencia de herramientas](../tools.md) enumera cada herramienta con sus parámetros y los
perfiles a los que pertenece.

## <a id="troubleshooting"></a>Solución de problemas

[docs/troubleshooting.md](../troubleshooting.md) explica cada código de error y qué hacer cuando no
se encuentra TradingView, el puerto de depuración está ocupado, un cliente no muestra las
herramientas o un túnel rechaza una petición. `npx -y tradingview-desktop-mcp doctor` es lo primero
que hay que ejecutar.

## <a id="dashboard"></a>Panel

El servidor incluye un panel web para ver lo que hace tu asistente y para probar una herramienta a
mano. No requiere ninguna instalación adicional: el paquete publicado ya lo incluye, y `pnpm build`
lo compila dentro del servidor de una copia del repositorio.

![La página de estado: TradingView accesible, con un gráfico encontrado y la aplicación lista, los datos del servidor y los límites del plan](../images/dashboard-status.png)

### <a id="open-it"></a>Abrirlo

- **Transporte HTTP:** inicia el servidor con un token y abre `http://127.0.0.1:8787/`. En este modo
  el panel está activado por defecto; `--no-dashboard` (`TV_MCP_DASHBOARD=false`) lo desactiva.

  ```sh
  TV_MCP_AUTH_TOKEN="$(openssl rand -hex 32)" npx -y tradingview-desktop-mcp --transport http
  ```

  Desde una copia del repositorio, ejecuta en su lugar `node packages/server/dist/cli.js --transport http`.

- **Junto a stdio:** un cliente MCP que inicia el servidor por stdio también puede tener un panel.
  Añade `--dashboard` (`TV_MCP_DASHBOARD=true`) y `TV_MCP_AUTH_TOKEN` a su configuración. El panel
  escucha en su propia dirección, `127.0.0.1:8787` salvo que definas `--host` y `--port`, y no sirve
  `/mcp`. Sin el token, o si el puerto está ocupado, el panel permanece desactivado y el servidor
  registra una advertencia, pero el servidor MCP sigue funcionando. Las llamadas que hace el cliente
  aparecen en el registro en directo.

El servidor imprime la dirección del panel en stderr al arrancar. Nunca imprime el token.

### <a id="the-token"></a>El token

La página pide el token (`TV_MCP_AUTH_TOKEN`) antes de mostrar nada. Pégalo, o abre una vez
`http://127.0.0.1:8787/#token=<token>`: la página lee el token del fragmento y lo elimina de la
dirección, y el fragmento nunca se envía al servidor. La página guarda el token en `sessionStorage`,
así que desaparece al cerrar la pestaña, y solo lo envía como `Authorization: Bearer <token>`, nunca
en una URL. Cuando el servidor se reinicia con otro token, la página lo vuelve a pedir. Consulta
[SECURITY.md](../../SECURITY.md#the-dashboard).

### <a id="what-it-shows"></a>Qué muestra

![El registro en directo: una tabla de llamadas a herramientas, las más recientes primero, con su hora, herramienta, origen, estado y duración, y encima la búsqueda y los filtros](../images/dashboard-log.png)

- **Status** muestra si TradingView es accesible (y cómo iniciarlo si no lo es), cómo se está
  ejecutando el servidor, los límites del plan y las últimas llamadas.
- **Log** transmite cada llamada a herramienta que ejecuta el servidor, tanto si la hizo un cliente
  MCP como el panel, con un filtro por nombre de herramienta, pausa, borrado y los detalles de cada
  llamada. Tras una conexión caída muestra «Reconectando…» y continúa donde se quedó. Cada pestaña
  abierta del panel mantiene un flujo de eventos con el servidor, y un navegador permite unas seis
  conexiones a un mismo host, así que con muchas pestañas del panel abiertas una nueva puede quedarse
  esperando una conexión libre: cierra las pestañas que no uses.
- **Tools** enumera las herramientas que ofrece el servidor, con sus parámetros, y ejecuta una a
  mano. El resultado se muestra tal como llegó, con el JSON largo plegado tras «Mostrar todo» y las
  imágenes como imágenes.

![La página de herramientas: a la izquierda la lista de herramientas con su búsqueda y filtros, y a la derecha chart_get_state con su descripción, datos y campos de entrada](../images/dashboard-tools.png)

Una ejecución desde el panel es una llamada real a una herramienta. Pasa por el mismo registro que
una llamada MCP, así que se aplican los mismos esquemas, el mismo perfil, las mismas reglas de
`confirm` y las mismas comprobaciones de límites del plan, y aparece en el log. El panel te pide
confirmación antes de ejecutar cualquier herramienta que no sea de solo lectura.

### <a id="the-api"></a>La API

La página se comunica con el servidor mediante una pequeña API, que también puedes llamar con `curl`
y el token. Cada ruta requiere `Authorization: Bearer <token>`, y el servidor comprueba `Host` y
`Origin` igual que hace con `/mcp`.

| Ruta                     | Qué hace                                                                          |
| ------------------------ | --------------------------------------------------------------------------------- |
| `GET /api/info`          | Versión, transporte, perfil, número de herramientas y hora de inicio              |
| `GET /api/health`        | El informe de estado: si TradingView es accesible                                 |
| `GET /api/tools`         | Las herramientas disponibles, con sus esquemas y anotaciones                      |
| `POST /api/tools/<name>` | Ejecuta una herramienta con `{"arguments": {...}}`, con el origen `dashboard`     |
| `GET /api/events`        | Server-sent events de las llamadas a herramientas; `?limit=` fija cuántas repetir |

Los archivos de la propia página, en `/`, no necesitan token y no contienen datos.

## <a id="contributing"></a>Contribuir

Consulta [CONTRIBUTING.md](../../CONTRIBUTING.md) para la configuración local, los niveles de pruebas, las
convenciones de commits y cómo se publica una versión, y [docs/testing.md](../testing.md) para la
guía de pruebas. Para informar de una vulnerabilidad, sigue [SECURITY.md](../../SECURITY.md).

## <a id="disclaimer"></a>Aviso legal

Este proyecto no está afiliado a TradingView, Inc., ni cuenta con su respaldo o patrocinio.
TradingView es una marca comercial de su propietario. Nada de lo que aquí aparece constituye
asesoramiento financiero. Las herramientas cambian lo que muestra la aplicación y pueden acceder a
sus controles, así que eres responsable de lo que automatizas y de cumplir las condiciones de uso de
TradingView.

## <a id="license"></a>Licencia

Publicado bajo la [licencia MIT](../../LICENSE).
