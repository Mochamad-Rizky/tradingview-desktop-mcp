# tradingview-desktop-mcp

[English](../../README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Türkçe](README.tr.md) · [Русский](README.ru.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Українська](README.uk.md) · [Polski](README.pl.md) · [Português (Brasil)](README.pt-BR.md) · **العربية** · [فارسی](README.fa.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Ελληνικά](README.el.md) · [മലയാളം](README.ml.md) · [Roman Urdu](README.ur-Latn.md) · [Română](README.ro.md)

[![npm](https://img.shields.io/npm/v/tradingview-desktop-mcp)](https://www.npmjs.com/package/tradingview-desktop-mcp)
[![CI](https://github.com/Mochamad-Rizky/tradingview-desktop-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Mochamad-Rizky/tradingview-desktop-mcp/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/Mochamad-Rizky/tradingview-desktop-mcp/graph/badge.svg)](https://codecov.io/gh/Mochamad-Rizky/tradingview-desktop-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../../LICENSE)

> هذه ترجمة لملف [README الإنجليزي](../../README.md). إذا اختلفت النسختان، فالنسخة الإنجليزية هي المرجع.

<p align="center">
  <a href="../media/promo.mp4"><img src="../media/teaser.gif" width="49%" alt="الفيديو التعريفي: مساعد يقرأ رسمًا بيانيًا، ويرسم خط دعم، ويكتب سكربت Pine Script، ويضبط تنبيهًا سعريًا"></a>
  <a href="../media/tutorial.mp4"><img src="../media/tutorial-poster.jpg" width="49%" alt="شرح الإعداد: جهّزه في خمس خطوات"></a>
</p>

<p align="center">
  <a href="../media/promo.mp4"><b>▶ شاهد الفيديو التعريفي</b></a> (0:48) &nbsp;·&nbsp;
  <a href="../media/tutorial.mp4"><b>▶ شاهد شرح الإعداد</b></a> (1:53)<br>
  <sub>يستخدم الفيديوهان رسمًا بيانيًا مختلَقًا، وليس بيانات سوق حقيقية.</sub>
</p>

خادم [MCP](https://modelcontextprotocol.io) يتيح لمساعدي الذكاء الاصطناعي قراءة تطبيق TradingView Desktop
على جهازك والتحكم فيه. وهو يتحكم في التطبيق الذي سجّلت الدخول إليه مسبقًا عبر Chrome DevTools Protocol،
من خلال منفذ التصحيح (debug port) الذي يفتحه التطبيق عند تشغيله مع `--remote-debugging-port`. وهو يؤتمت
التطبيق المحلي فقط: لا يسجّل الدخول نيابةً عنك، ولا يتجاوز حدود الخطة، ولا يتصل بخوادم TradingView.

> **الحالة: ما قبل الإصدار 1.0.** قد تتغير أسماء الأدوات وخياراتها قبل الإصدار 1.0. ثبّت الحزمة من npm،
> كما هو موضح أدناه، أو شغّل الخادم [من الشيفرة المصدرية](#quick-start-from-source). جُرّب على macOS؛
> أما على Windows وLinux فالدعم بقدر المستطاع.

يوفّر الخادم أدوات للتطبيق (التشغيل، وفحص السلامة، والاكتشاف، وحالة الواجهة، وحدود الخطة، وإعادة الاتصال)،
وأدوات للرسم البياني (الحالة، والرمز، والإطار الزمني، ونوع الرسم البياني، والنطاق المرئي، والتمرير)، وأدوات
لبيانات السوق (الأشرطة، والأسعار، ومعلومات الرموز والبحث عنها)، وأدوات للمؤشرات (العرض، والبحث، والإضافة،
والإزالة، والمدخلات، والإظهار، والقيم)، وأدوات Pine Script (المحرّر والسكربتات المحفوظة، والتصريف، والتصريف
الذكي مع إصلاحات قائمة على القواعد، والتحليل دون اتصال، ووحدة التحكم (console)، والخطوط والتسميات والصناديق
والجداول التي ترسمها السكربتات)، وأدوات Strategy Tester (النتائج، والصفقات، ومنحنى رأس المال)، وأدوات للرسومات
والتنبيهات وقوائم المراقبة، وأدوات للتخطيطات (layouts) والرسوم البيانية المتعددة وعلامات التبويب، وإعادة تشغيل
الأشرطة (bar replay)، ولقطات الشاشة، وأدوات واجهة منخفضة المستوى (النقر، والتحويم، والكتابة، والمفاتيح،
والتمرير، والبحث، واللوحات، وملء الشاشة، وتشغيل JavaScript في صفحة الرسم البياني عندما تسمح بذلك)، و`batch_run`
التي تشغّل عدة أدوات في استدعاء واحد. ويوفّر أيضًا موارد (resources) (سلامة التطبيق، وحالة الرسم البياني
وأشرطته، ومصدر Pine وآخر نتيجة تصريف، وتقرير الاستراتيجية، وقائمة المراقبة النشطة)، كلٌّ منها مع الأداة التي
تشاركه بياناته، وخمسة طلبات جاهزة (prompts) للمهام الشائعة. وتعرض لوحة تحكم ويب الاستدعاءات مباشرةً وتشغّل
الأدوات يدويًا (انظر [لوحة التحكم](#dashboard)).

المحتويات: [التثبيت بطلب من تطبيق الذكاء الاصطناعي](#install-by-asking-your-ai-app)، [التثبيت](#install)،
[ربط تطبيق الذكاء الاصطناعي](#connect-your-ai-app)، [العملاء البعيدون والأنفاق](#remote-clients-and-tunnels)،
[بدء سريع من الشيفرة المصدرية](#quick-start-from-source)، [الاستخدام](#use-it)،
[استكشاف الأخطاء وإصلاحها](#troubleshooting)، [لوحة التحكم](#dashboard)، [المساهمة](#contributing).

## <a id="install-by-asking-your-ai-app"></a>التثبيت بطلب من تطبيق الذكاء الاصطناعي

لا يلزمك كتابة أي أوامر بنفسك. إذا كان تطبيق الذكاء الاصطناعي لديك قادرًا على تشغيل الأوامر على حاسوبك، كما
هو الحال مع Claude Code وCursor وVS Code وWindsurf وGemini CLI وCodex CLI، فبإمكانه إجراء الإعداد نيابةً
عنك. أولًا:

1. ثبّت [TradingView Desktop](https://www.tradingview.com/desktop/) وسجّل الدخول.
2. ثبّت [Node.js](https://nodejs.org) (إصدار LTS)، إن لم يكن مثبّتًا لديك بعد.

ثم انسخ هذا الطلب، والصقه في تطبيق الذكاء الاصطناعي وأرسله:

```text
ثبّت لي خادم TradingView MCP. إنه حزمة npm باسم tradingview-desktop-mcp
(https://github.com/Mochamad-Rizky/tradingview-desktop-mcp). اتبع هذه الخطوات واشرح لي كل خطوة منها
بكلمات بسيطة:

1. تحقّق من أن Node.js 20.19 أو أحدث مثبّت. إن لم يكن كذلك، فتوقف وأخبرني كيف أثبّته.
2. شغّل "npx -y tradingview-desktop-mcp config <client>"، حيث <client> هو التطبيق الذي
   تعمل فيه (claude-code أو cursor أو vscode أو windsurf أو gemini-cli أو codex-cli). نفّذ ما يطبعه
   لإضافة الخادم إلى إعداداتي، وأبقِ على أي خوادم أخرى موجودة فيها بالفعل.
3. شغّل TradingView باستخدام "npx -y tradingview-desktop-mcp launch". إذا أفاد بأن TradingView
   يعمل بالفعل دون منفذ التصحيح، فاسألني أولًا، ولا تشغّله مرة أخرى مع --restart إلا بعد موافقتي،
   لأن ذلك يغلق TradingView وقد أفقد تغييرات غير محفوظة.
4. شغّل "npx -y tradingview-desktop-mcp doctor" وأخبرني هل نجحت جميع الفحوصات. إذا فشل
   فحص الرسم البياني، فاطلب مني إحضار علامة تبويب الرسم البياني إلى المقدمة في TradingView.
5. أخبرني هل عليّ إعادة تشغيلك، أو فتح محادثة جديدة، قبل أن تظهر أدوات TradingView.
```

عند الانتهاء، أعد تشغيل التطبيق أو افتح محادثة جديدة إن طلب منك ذلك، ثم اسأل "تحقّق من أن
TradingView متصل." بعدها جرّب [الطلبات أدناه](#try-these-prompts).

هل تستخدم Claude Desktop؟ لا يمكنه تشغيل الأوامر، لكن Claude Code وCursor وبقية التطبيقات المذكورة أعلاه
يمكنها إعداده لك: أضف "جهّزه لـ Claude Desktop (config claude-desktop)، وليس لهذا التطبيق." إلى نهاية
الطلب. يحتاج ChatGPT وOpenAI API إلى نفق (tunnel) تُعدّه يدويًا (انظر
[العملاء البعيدون والأنفاق](#remote-clients-and-tunnels)). إذا تعثّر المساعد، فاتبع الخطوات أدناه
بنفسك.

## <a id="install"></a>التثبيت

تحتاج إلى:

- TradingView Desktop، مثبّتًا ومسجّل الدخول فيه.
- Node.js 20.19 أو أحدث، والذي يوفّر `npx`.

لا يُثبَّت أي شيء آخر: تشغّل العملاء المذكورة أدناه الخادم باستخدام `npx -y tradingview-desktop-mcp`، الذي
يجلب الحزمة عند أول استخدام. شغّل TradingView مع منفذ التصحيح الخاص به. يعثر الأمر `launch` على التطبيق
ويشغّله بهذه الطريقة:

```sh
npx -y tradingview-desktop-mcp launch
```

لا يسمح TradingView إلا بنسخة واحدة قيد التشغيل. إذا كان يعمل بالفعل دون منفذ التصحيح، يتوقف `launch` ويُعلمك
بذلك؛ أما `launch --restart` فيغلقه بلطف ويعيد تشغيله مع المنفذ، وقد يطلب منك TradingView حفظ التغييرات
أولًا. تحقّق من أن الخادم يستطيع الوصول إلى التطبيق:

```sh
npx -y tradingview-desktop-mcp doctor
```

يفشل `doctor` في فحص الرسم البياني ما دامت علامة تبويب الرسم البياني في الخلفية، خلف صفحة New tab أو علامة
تبويب أخرى لا تحتوي على رسم بياني، لذا أحضِر علامة تبويب الرسم البياني إلى المقدمة.
يعرض `npx -y tradingview-desktop-mcp --help` الخيارات، ويعرض [.env.example](../../.env.example) متغيرات
البيئة.

## <a id="connect-your-ai-app"></a>ربط تطبيق الذكاء الاصطناعي

يطبع `config <client>` مقتطف الإعدادات الخاص بعميل ما ويخبرك بالمكان الذي يوضع فيه. يحتوي كل شرح أدناه على
المقتطف نفسه، وخطوات ذلك التطبيق، وما يجب فعله عندما لا يعمل.

| العميل                                         | اطبع المقتطف                                           |
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

طريقة النقل (transport) الافتراضية هي stdio، حيث لا يحمل stdout سوى رسائل MCP وتذهب السجلات إلى stderr.
تشغّل العملاء السبعة الأولى الخادم بنفسها. على Windows، يحتاج العميل الذي لا يستطيع تشغيل `npx` مباشرةً إلى
صيغة `cmd /c npx`، التي يطبعها `config` عندما يعمل على Windows (أو مع `--platform win32`). يمرّر `--profile`
[ملف تعريف أدوات](#tool-profiles) إلى الخادم.

### <a id="remote-clients-and-tunnels"></a>العملاء البعيدون والأنفاق

لا يستطيع ChatGPT وOpenAI API تشغيل برنامج على حاسوبك. فهما يصلان إلى الخادم عبر عنوان HTTPS عام، لذا
تشغّله عبر HTTP وتضع نفقًا أمامه. وهذا يضع على الإنترنت خادمًا قادرًا على التحكم في TradingView الذي سجّلت
الدخول إليه: استخدم `--profile readonly`، ورمز وصول (token) قويًا (`TV_MCP_AUTH_TOKEN`)، والمضيف العام للنفق
في `--allowed-hosts` (`TV_MCP_ALLOWED_HOSTS`)، و`--no-dashboard`، حتى لا تُقدَّم ملفات لوحة التحكم عبر النفق.
يشرح الدليلان الخاصان بـ [ChatGPT](../clients/chatgpt.md)
و[OpenAI API](../clients/openai-api.md) ذلك خطوة بخطوة، ويسرد
[SECURITY.md](../../SECURITY.md#tunnels-and-remote-clients) ما يظل بإمكان رمز القراءة فقط الوصول إليه.

## <a id="quick-start-from-source"></a>بدء سريع من الشيفرة المصدرية

لتشغيل نسخة مستنسخة من المستودع بدلًا من الحزمة المنشورة، تحتاج إلى Node.js 24 لبناء الخادم
(يقرأ `nvm use` الملف `.nvmrc`) وإلى [pnpm](https://pnpm.io)، الذي يثبّت `package.json` إصداره. يعمل الخادم
بعد بنائه على Node.js 20.19 أو أحدث.

```sh
git clone https://github.com/Mochamad-Rizky/tradingview-desktop-mcp.git
cd tradingview-desktop-mcp
pnpm install && pnpm build
node packages/server/dist/cli.js launch
node packages/server/dist/cli.js doctor
```

يطبع `node packages/server/dist/cli.js config <client> --local` مقتطف عميل لهذه النسخة المستنسخة، مع `node`
والمسار المطلق لـ `cli.js` بدلًا من `npx`. بالنسبة لعميل ذي إعدادات بصيغة JSON، يبدو الإدخال هكذا:

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

يوجد أيضًا نقل عبر HTTP (`--transport http`)؛ اقرأ [SECURITY.md](../../SECURITY.md) قبل أن
تستخدمه.

## <a id="use-it"></a>الاستخدام

اربط عميل MCP كما هو موضح أعلاه، مع تشغيل TradingView بمنفذ التصحيح، واطلب ما تريد بكلمات بسيطة. يختار
المساعد الأدوات ويستدعيها، فلا حاجة إلى أن تعرف أسماءها. يسرد [مرجع الأدوات](../tools.md) كل أداة مع
مدخلاتها وملفات التعريف التي تنتمي إليها.

### <a id="try-these-prompts"></a>جرّب هذه الطلبات

كل طلب أدناه هو أحد الأمثلة في [docs/examples.md](../examples.md)، الذي يعرض استدعاءات الأدوات التي يجريها
المساعد ونتائجها، مع اقتطاع القوائم الأطول من ثلاثة عناصر، وحذف مدة كل استدعاء (`durationMs`)، والإشارة إلى
لقطة الشاشة في ملاحظة بدلًا من عرضها. المقتطفات أسطر من تلك النتائج، وتشير `…` إلى المواضع التي حُذفت فيها
أسطر من أجزاء أخرى من النتيجة. القيم اصطناعية: فهي مأخوذة من تطبيق TradingView مزيّف برسم بياني مختلَق لـ
NASDAQ:AAPL، فلا شيء منها بيانات سوق ولا شيء منها يأتي من حساب؛ ومع ذلك فللنتائج الشكل نفسه الذي يعطيها إياه
الخادم، وإن كان تقرير Strategy Tester الذي يستند إليه مثال الاختبار الرجعي (backtest) لم يُقرأ من التطبيق
الحقيقي بعد.

**"ما الذي أنظر إليه في الرسم البياني؟ أخبرني بالرمز والإطار الزمني والمؤشرات الموجودة
عليه."** يقرأ المساعد الرسم البياني باستخدام `chart_get_state`
([التفاصيل](../examples.md#1-read-the-chart)):

```json
"symbol": "NASDAQ:AAPL",
"resolution": "1D",
"chartTypeName": "candles",
```

**"اعرض لي آخر 3 شموع يومية."** يقرأ الأشرطة باستخدام `data_get_ohlcv`
([التفاصيل](../examples.md#3-read-the-last-candles)):

```json
"timeIso": "2024-10-27T00:00:00Z",
"open": 103.58,
"close": 103.42,
```

**"أضف مؤشر MACD إلى الرسم البياني."** على رسم بياني يحمل أقصى عدد من المؤشرات تسمح به الخطة، لا تضيف
`indicator_add` شيئًا وتُبلغ عن الحد، وتتطلب إزالة أحد مؤشراتك لإفساح المجال موافقتك
([التفاصيل](../examples.md#5-add-an-indicator-to-a-full-chart)):

```json
"code": "PLAN_LIMIT",
"message": "The chart holds as many indicators as the plan allows (2)",
```

**"اكتب مؤشر Pine Script يرسم متوسطًا متحركًا لـ 9 أشرطة وآخر لـ 21 شريطًا لسعر الإغلاق، وتحقّق من أنه
يُصرَّف بنجاح."** يضع السكربت في Pine Editor باستخدام `pine_new` ويصرّفه باستخدام
`pine_compile` ([التفاصيل](../examples.md#6-write-and-compile-a-pine-script)):

```json
"success": true,
"errors": [],
"warnings": [],
```

**"السكربت في Pine Editor لا يُصرَّف. هل يمكنك إصلاحه؟"** تصرّف `pine_smart_compile` السكربت، وتطبّق
إصلاحات قائمة على القواعد للأخطاء التي تعرفها، مثل أسماء Pine v4 في سكربت v6، ثم تصرّفه مرة أخرى، دون
تغيير ما في المحرّر
([التفاصيل](../examples.md#7-fix-a-pine-script-with-smart-compile)):

```json
"message": "Could not find function or function reference 'study'",
…
"applied": ["Replace study( with indicator(", "Replace rsi( with ta.rsi("]
…
"writtenBack": false
```

**"كيف كان أداء الاستراتيجية الموجودة على الرسم البياني في الاختبار الرجعي؟"** يقرأ Strategy Tester باستخدام
`strategy_get_results` و`strategy_get_trades`
([التفاصيل](../examples.md#8-read-backtest-results)):

```json
"netProfit": 155,
"totalTrades": 3,
"percentProfitable": 66.67,
"profitFactor": 4.1,
```

**"ارسم خط دعم عند 102.80 على الرسم البياني."** يرسم خطًا أفقيًا باستخدام `drawing_create`، وتعرضه
`drawing_list` بجانب رسوماتك، موسومًا بأنه من رسم هذه الجلسة
([التفاصيل](../examples.md#9-draw-a-support-line)):

```json
"id": "DRW001",
"shape": "horizontal_line",
"text": "Support",
"createdByServer": true
```

**"نبّهني عندما يتجاوز سعر Apple مستوى 110."** تضبط `alert_create` تنبيهًا سعريًا في حسابك على TradingView
([التفاصيل](../examples.md#10-create-a-price-alert)). وعندما تكون الخطة قد بلغت بالفعل أقصى عدد من
التنبيهات تسمح به، لا تُنشئ شيئًا وتُبلغ عن الحد، وتعرض `alert_list` التنبيهات التي تملؤها
([التفاصيل](../examples.md#11-create-an-alert-when-the-plan-is-full)):

```json
"symbol": "NASDAQ:AAPL",
"condition": "crossing",
"price": 110,
"expirationIso": "2024-11-26T00:00:00Z"
```

**"أضف هذه الرموز إلى قائمة المراقبة: NYSE:IBM و FX:EURUSD و NASDAQ:MSFT و NASDAQ:MSTF."**
تتحقق `watchlist_add_bulk` من كل رمز عبر بحث الرموز في TradingView، وتضيف الرموز الجديدة وتوضح سبب تخطيها
للبقية ([التفاصيل](../examples.md#12-add-symbols-to-a-watchlist)):

```json
"added": ["NYSE:IBM", "FX:EURUSD"],
…
{ "symbol": "NASDAQ:MSFT", "reason": "already_listed" },
{ "symbol": "NASDAQ:MSTF", "reason": "unknown" }
```

**"دعني أتدرّب على إعادة تشغيل أشرطة الرسم البياني بدءًا من 2024-06-03: تقدّم خمسة أشرطة للأمام، وأخبرني
أين نحن، ثم أنهِ الإعادة."** يبدأ إعادة تشغيل الأشرطة باستخدام `replay_start`، ويتقدّم باستخدام
`replay_step`، ويقرأ موضع الإعادة باستخدام `replay_status` ويخرج منها باستخدام `replay_stop`. لا يُتداول أي
شيء: لا توجد أداة تضع أوامر تداول ([التفاصيل](../examples.md#13-practice-with-bar-replay)):

```json
"dateIso": "2024-06-07T00:00:00Z",
"stepped": 5,
…
"position": null,
"realizedPL": null
```

**"التقط لقطة شاشة للرسم البياني."** تسلّم `screenshot_capture` الصورة إلى المساعد على هيئة صورة، مع
أبعادها، ولا تكتب شيئًا على القرص
([التفاصيل](../examples.md#14-take-a-screenshot)):

```json
"data": { "target": "chart", "format": "jpeg", "width": 1180, "height": 640, "bytes": 3100 },
"meta": { "via": "cdp", "warnings": [] }
```

يوفّر الخادم أيضًا خمسة طلبات جاهزة (prompts) خاصة به، يسردها لك العميل الذي يدعم MCP prompts لتختار منها:
`analyze_current_chart` و`multi_timeframe_review` و`write_and_backtest_strategy`
و`debug_pine_script` و`replay_practice_session`. يخبر كلٌّ منها المساعد بالأدوات التي عليه استدعاؤها، وبأي
ترتيب، وبما يُبلغ عنه في النهاية. يشغّل `replay_practice_session` جلسة تدريب على إعادة تشغيل الأشرطة: يتقدّم
المساعد عبر الماضي شريطًا تلو الآخر، ويسألك في كل خطوة هل ستشتري (long) أو تبيع على المكشوف (short) أو تبقى
خارج السوق، ويحتفظ بسجلّ لهذه الصفقات الافتراضية بأسعار يقرؤها من الرسم البياني، ويحسب ربحها أو خسارتها.
ويتحقق أولًا مما إذا كانت هناك إعادة تشغيل خاصة بك قيد العمل، ويسألك ماذا يفعل بها قبل أن يغيّر أي شيء؛ وفي
النهاية يوقف الإعادة التي بدأها هو، ولا يوقف أبدًا أيًّا من إعاداتك.

### <a id="safety"></a>الأمان

تتعامل الأدوات التي تغيّر الرسم البياني أو السكربتات أو حسابك بحذر مع ما هو لك بالفعل. فاستبدال نص غير محفوظ
في Pine Editor (عدا تعديل غير محفوظ أجرته هذه الجلسة من الخادم بنفسها هناك)، وحفظ إصدار جديد من سكربت لم
تُنشئه هذه الجلسة، وإزالة مؤشر كان موجودًا بالفعل على الرسم البياني، كلها تتطلب `confirm: true`، التي لا
ينبغي للمساعد تمريرها إلا بعد موافقتك. وكذلك الحال مع إزالة رسم أو تنبيه أو رمز من قائمة المراقبة أو علامة
تبويب لم تُنشئها هذه الجلسة أو تضفها أو تفتحها، وإزالة جميع رسومات رسم بياني ما، والانتقال من تخطيط فيه
تغييرات غير محفوظة، والتحول إلى تخطيط متعدد الرسوم البيانية يضم رسومًا أقل مما تعرضه علامة التبويب، إذ
سيُسقط الحفظ التالي البقية. أي حد من حدود الخطة، مثل عدد المؤشرات على رسم بياني، أو السكربتات المحفوظة، أو
التنبيهات، أو الرسوم البيانية في تخطيط، يُفحص قبل إضافة أي شيء ويُبلَّغ عنه كخطأ `PLAN_LIMIT` مع قيمة الحد؛
وعندما يتعذر قراءة الحد في إصدار TradingView لديك، لا تفعل الأداة شيئًا وتوضح ذلك. لا يتحايل الخادم على أي
حد. تتحقق الأدوات أولًا مما قد يجعل TradingView يفتح نافذة الترقية، أو نافذة حوار أخرى خاصة به، فترفض بدلًا
من ذلك، لكن تبقى بعض النوافذ التي لا تستطيع هذه الفحوصات توقّعها:
قد تواجه `layout_switch` نافذة ترقية لتخطيط محفوظ متعدد الرسوم البيانية على خطة تسمح برسوم أقل، أو لتخطيط
يرفضه خادم TradingView لتجاوزه الحد، أو لتخطيط تَسِمه القائمة التي يحتفظ بها TradingView لنفسه بأنه فوق الحد
بينما لا تفعل `layout_list` ذلك؛ وقد تواجه `layout_new` رسالة من TradingView عندما يرفض التخطيط الجديد بعد
الفحوصات؛ وقد تواجه `tab_close` نافذة الحوار "Close tab?" لصفحة تستغرق وقتًا أطول مما ينتظره TradingView
ليعرف هل في تخطيطها تغييرات غير محفوظة، أو لصفحة تُبلغ عن تسجيل قيد التقدم. أما أدوات `ui_*` منخفضة المستوى
فتنقر وتكتب ما تطلبه منها، لذا قد تفتح نوافذ حوار TradingView بحكم تصميمها. ولا يحذف الخادم أي سكربت ولا
يعيد تسميته.

لا توجد أداة تضع أوامر تداول: إعادة تشغيل الأشرطة مخصّصة للتدريب، ويحتفظ المساعد بأي صفقات تدريبية داخل
المحادثة. تذهب لقطات الشاشة إلى العميل على هيئة صور، ولا يكتب الخادم أيًّا منها على القرص.
أما `ui_evaluate`، التي تشغّل JavaScript في صفحة الرسم البياني، فهي معطّلة ما لم تشغّل الخادم مع
`--allow-eval` (`TV_MCP_ALLOW_EVAL=true`).

### <a id="tool-profiles"></a>ملفات تعريف الأدوات

افتراضيًا يوفّر الخادم جميع أدواته البالغ عددها 83 (`--profile full`). بعض العملاء لا تقبل إلا عددًا محدودًا
من الأدوات (يُظهر Cursor تحذيرًا عند تجاوز 40). ولهذه العملاء، يوفّر `--profile core` مجموعة مختصرة من 40
أداة أساسية، ويوفّر `--profile readonly` الأدوات الـ 37 التي تقتصر على القراءة فقط. يقبل `--tools` أنماط أسماء
مثل `chart_*,data_*` ويضيّق ملف التعريف أكثر: يجب أن تكون الأداة ضمن ملف التعريف وأن تطابق أحد الأنماط، لذا
فإن `--profile core --tools 'pine_*'` يستبعد مع ذلك `pine_open` و`pine_save`، لأنهما ليستا من أدوات core؛
ومع ملف التعريف الافتراضي، يختار `--tools` وحده الأدوات.
تذكر بعض الأوصاف والتلميحات أدوات يستبعدها `core`، مثل `pine_open` و`pine_save`، والتي لا يستطيع المساعد
استدعاءها في ظل `core`. وتتبع الموارد الأدوات: لا يُقدَّم كل مورد إلا مع الأداة التي تشاركه بياناته، مثل
`tradingview://pine/source` مع `pine_get_source`، لذا فإن `--tools 'chart_*'` يقدّم حالة الرسم البياني ولا
شيء من Pine Editor.

يسرد [مرجع الأدوات](../tools.md) كل أداة مع مدخلاتها وملفات التعريف التي تنتمي إليها.

## <a id="troubleshooting"></a>استكشاف الأخطاء وإصلاحها

يشرح [docs/troubleshooting.md](../troubleshooting.md) كل رمز خطأ وما يجب فعله عندما لا يُعثر على
TradingView، أو يكون منفذ التصحيح مشغولًا، أو لا يعرض العميل الأدوات، أو يرفض النفق طلبًا. أول ما يجب تشغيله
هو `npx -y tradingview-desktop-mcp doctor`.

## <a id="dashboard"></a>لوحة التحكم

يأتي الخادم مع لوحة تحكم ويب لمراقبة ما يفعله مساعدك ولتجربة أداة يدويًا. لا تحتاج إلى أي تثبيت إضافي:
فالحزمة المنشورة تتضمنها، و`pnpm build` يبنيها داخل خادم النسخة المستنسخة.

![صفحة الحالة: يمكن الوصول إلى TradingView مع العثور على رسم بياني والتطبيق جاهز، ومعلومات الخادم، وحدود الخطة](../images/dashboard-status.png)

### <a id="open-it"></a>فتحها

- **نقل HTTP:** شغّل الخادم مع رمز وصول وافتح `http://127.0.0.1:8787/`. تكون لوحة التحكم مفعّلة
  افتراضيًا في هذا الوضع؛ ويعطّلها `--no-dashboard` (`TV_MCP_DASHBOARD=false`).

  ```sh
  TV_MCP_AUTH_TOKEN="$(openssl rand -hex 32)" npx -y tradingview-desktop-mcp --transport http
  ```

  من نسخة مستنسخة، شغّل `node packages/server/dist/cli.js --transport http` بدلًا من ذلك.

- **بجانب stdio:** يمكن لعميل MCP يشغّل الخادم عبر stdio أن يحصل على لوحة تحكم أيضًا. أضف
  `--dashboard` (`TV_MCP_DASHBOARD=true`) و`TV_MCP_AUTH_TOKEN` إلى إعداداته. تستمع لوحة التحكم على
  عنوانها الخاص، `127.0.0.1:8787` ما لم تضبط `--host` و`--port`، ولا تقدّم المسار
  `/mcp`. وبدون رمز الوصول، أو عندما يكون المنفذ مشغولًا، تبقى لوحة التحكم معطّلة ويسجّل الخادم تحذيرًا،
  لكن خادم MCP يستمر في العمل. تظهر الاستدعاءات التي يجريها العميل في السجل المباشر.

يطبع الخادم عنوان لوحة التحكم على stderr عند بدء تشغيله. ولا يطبع رمز الوصول أبدًا.

### <a id="the-token"></a>رمز الوصول

تطلب الصفحة رمز الوصول (`TV_MCP_AUTH_TOKEN`) قبل أن تعرض أي شيء. الصقه، أو افتح
`http://127.0.0.1:8787/#token=<token>` مرة واحدة: تقرأ الصفحة الرمز من الجزء (fragment) وتزيله من العنوان،
ولا يُرسَل الجزء إلى الخادم أبدًا. تحتفظ الصفحة بالرمز في `sessionStorage`، فيزول عند إغلاق علامة
التبويب، ولا ترسله إلا على هيئة `Authorization: Bearer <token>`، وليس في عنوان URL أبدًا. عندما يُعاد تشغيل
الخادم برمز آخر، تطلبه الصفحة مجددًا. انظر [SECURITY.md](../../SECURITY.md#the-dashboard).

### <a id="what-it-shows"></a>ما الذي تعرضه

![السجل المباشر: جدول باستدعاءات الأدوات، الأحدث أولًا، مع وقتها والأداة والمصدر والحالة والمدة، وفوقه البحث والمرشّحات](../images/dashboard-log.png)

- **Status** (الحالة) تعرض هل يمكن الوصول إلى TradingView (وكيف تشغّله إن لم يكن كذلك)، وكيف يعمل
  الخادم، وحدود الخطة، وآخر الاستدعاءات.
- **Log** (السجل) يبث كل استدعاء أداة يشغّله الخادم، سواء أجراه عميل MCP أو لوحة التحكم، مع مرشّح حسب
  اسم الأداة، وإيقاف مؤقت، ومسح، وتفاصيل كل استدعاء. بعد انقطاع الاتصال يعرض "Reconnecting…" ويستأنف
  من حيث توقف. تحتفظ كل علامة تبويب مفتوحة للوحة التحكم بتدفق أحداث واحد إلى الخادم، ويسمح المتصفح
  بنحو ستة اتصالات بالمضيف الواحد، لذا عند فتح علامات تبويب كثيرة للوحة التحكم قد تنتظر علامة جديدة
  اتصالًا متاحًا: أغلق علامات التبويب التي لا
  تستخدمها.
- **Tools** (الأدوات) يسرد الأدوات التي يوفّرها الخادم، مع مدخلاتها، ويشغّل أيًّا منها يدويًا. تُعرض
  النتيجة كما عادت، مع طيّ JSON الطويل خلف "Show all" وعرض الصور كصور.

![صفحة الأدوات: قائمة الأدوات مع البحث والمرشّحات على اليسار، و chart_get_state مع وصفها ومعلوماتها وحقول مدخلاتها على اليمين](../images/dashboard-tools.png)

التشغيل من لوحة التحكم هو استدعاء أداة حقيقي. فهو يمرّ عبر السجلّ (registry) نفسه الذي يمرّ به استدعاء MCP،
لذا تنطبق المخططات (schemas) نفسها، وملف التعريف نفسه، وقواعد `confirm` وفحوصات حدود الخطة، ويظهر في السجل.
تطلب منك لوحة التحكم التأكيد قبل تشغيل أي أداة ليست للقراءة فقط.

### <a id="the-api"></a>واجهة API

تتواصل الصفحة مع الخادم عبر API صغيرة، يمكنك أيضًا استدعاؤها باستخدام `curl` ورمز الوصول. يتطلب كل مسار
`Authorization: Bearer <token>`، ويتحقق الخادم من `Host` و`Origin` كما يفعل مع
`/mcp`.

| المسار                   | ما يفعله                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------- |
| `GET /api/info`          | الإصدار، وطريقة النقل، وملف التعريف، وعدد الأدوات، ووقت البدء                       |
| `GET /api/health`        | تقرير السلامة: هل يمكن الوصول إلى TradingView                                       |
| `GET /api/tools`         | الأدوات المتاحة، مع مخططاتها وتعليقاتها التوضيحية (annotations)                     |
| `POST /api/tools/<name>` | يشغّل أداة باستخدام `{"arguments": {...}}`، بالمصدر `dashboard`                     |
| `GET /api/events`        | أحداث مُرسَلة من الخادم (SSE) لاستدعاءات الأدوات؛ يحدّد `?limit=` عدد ما يُعاد بثّه |

ملفات الصفحة نفسها، عند `/`، لا تحتاج إلى رمز وصول ولا تحتوي على أي بيانات.

## <a id="contributing"></a>المساهمة

انظر [CONTRIBUTING.md](../../CONTRIBUTING.md) لمعرفة الإعداد المحلي، ومستويات الاختبار، وأعراف رسائل الـ commit،
وكيفية إصدار نسخة جديدة، و[docs/testing.md](../testing.md) لدليل الاختبار. للإبلاغ عن
ثغرة أمنية، اتبع [SECURITY.md](../../SECURITY.md).

## <a id="disclaimer"></a>إخلاء المسؤولية

هذا المشروع غير تابع لشركة TradingView, Inc. ولا معتمد منها ولا مموَّل من قِبلها. TradingView علامة تجارية
مملوكة لصاحبها. لا شيء هنا يُعد نصيحة مالية. تغيّر الأدوات ما يعرضه التطبيق وقد تصل إلى عناصر التحكم فيه،
لذا فأنت مسؤول عمّا تؤتمته وعن الالتزام بشروط استخدام TradingView.

## <a id="license"></a>الترخيص

صادر بموجب [رخصة MIT](../../LICENSE).
