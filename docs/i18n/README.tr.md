# tradingview-desktop-mcp

[English](../../README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · **Türkçe** · [Русский](README.ru.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Українська](README.uk.md) · [Polski](README.pl.md) · [Português (Brasil)](README.pt-BR.md) · [العربية](README.ar.md) · [فارسی](README.fa.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Ελληνικά](README.el.md) · [മലയാളം](README.ml.md) · [Roman Urdu](README.ur-Latn.md) · [Română](README.ro.md)

[![npm](https://img.shields.io/npm/v/tradingview-desktop-mcp)](https://www.npmjs.com/package/tradingview-desktop-mcp)
[![CI](https://github.com/Mochamad-Rizky/tradingview-desktop-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Mochamad-Rizky/tradingview-desktop-mcp/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/Mochamad-Rizky/tradingview-desktop-mcp/graph/badge.svg)](https://codecov.io/gh/Mochamad-Rizky/tradingview-desktop-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../../LICENSE)

> Bu belge [İngilizce README](../../README.md) dosyasının çevirisidir. İkisi arasında fark olursa İngilizce sürüm esas alınır.

<p align="center">
  <a href="../media/promo.mp4"><img src="../media/teaser.gif" width="49%" alt="Tanıtım videosu: bir asistan grafiği okuyor, bir destek çizgisi çiziyor, bir Pine Script yazıyor ve bir fiyat alarmı kuruyor"></a>
  <a href="../media/tutorial.mp4"><img src="../media/tutorial-poster.jpg" width="49%" alt="Kurulum eğitimi: beş adımda kurun"></a>
</p>

<p align="center">
  <a href="../media/promo.mp4"><b>▶ Tanıtımı izleyin</b></a> (0:48) &nbsp;·&nbsp;
  <a href="../media/tutorial.mp4"><b>▶ Kurulum eğitimini izleyin</b></a> (1:53)<br>
  <sub>Her iki video da piyasa verisi değil, uydurma bir grafik kullanır.</sub>
</p>

Yapay zekâ asistanlarının kendi bilgisayarınızdaki TradingView Desktop uygulamasını okumasını ve
kontrol etmesini sağlayan bir [MCP](https://modelcontextprotocol.io) sunucusu. Zaten oturum açmış
olduğunuz uygulamayı Chrome DevTools Protocol üzerinden, uygulamanın `--remote-debugging-port` ile
başlatıldığında açtığı hata ayıklama portu aracılığıyla yönetir. Yalnızca yerel uygulamayı otomatikleştirir:
sizin yerinize oturum açmaz, plan sınırlarını aşmaz ve TradingView'in sunucularını çağırmaz.

> **Durum: 1.0 öncesi.** Araç adları ve seçenekler 1.0'dan önce değişebilir. Paketi aşağıdaki gibi
> npm'den kurun ya da sunucuyu [kaynaktan](#quick-start-from-source) çalıştırın. macOS üzerinde
> denendi; Windows ve Linux desteği elden gelen en iyi çabayla sunulur.

Sunucu şunları sunar: uygulama araçları (başlatma, sağlık durumu, keşif, arayüz durumu, plan
sınırları, yeniden bağlanma), grafik araçları (durum, sembol, zaman dilimi, grafik türü, görünür
aralık, kaydırma), piyasa verisi araçları (çubuklar, kotasyonlar, sembol bilgisi ve arama), indikatör
araçları (listeleme, arama, ekleme, kaldırma, girdiler, görünürlük, değerler), Pine Script araçları
(editör ve kayıtlı betikler, derleme, kural tabanlı düzeltmelerle akıllı derleme, çevrimdışı analiz,
konsol ve betiklerin çizdiği çizgiler, etiketler, kutular ve tablolar), Strategy Tester araçları
(sonuçlar, işlemler, sermaye eğrisi), çizim, alarm ve izleme listesi araçları, düzen, çoklu grafik ve
sekme araçları, bar replay, ekran görüntüleri, düşük seviyeli arayüz araçları (tıklama, üzerine
gelme, yazma, tuşlar, kaydırma, bulma, paneller, tam ekran ve izin verdiğinizde grafik sayfasında
JavaScript) ve birkaç aracı tek çağrıda çalıştıran `batch_run`. Ayrıca kaynaklar da sunar (uygulama
sağlığı, grafik durumu ve çubuklar, Pine kaynağı ve son derleme sonucu, strateji raporu, etkin izleme
listesi); her biri verisini paylaştığı araçla birlikte sunulur. Yaygın işler için beş hazır komut
istemi (prompt) de vardır. Bir web paneli çağrıları canlı olarak gösterir ve araçları elle çalıştırır
(bkz. [Panel](#dashboard)).

İçindekiler: [Yapay zekâ uygulamanıza sorarak kurun](#install-by-asking-your-ai-app), [Kurulum](#install),
[Yapay zekâ uygulamanızı bağlayın](#connect-your-ai-app), [Uzak istemciler ve tüneller](#remote-clients-and-tunnels),
[Kaynaktan hızlı başlangıç](#quick-start-from-source), [Kullanım](#use-it),
[Sorun giderme](#troubleshooting), [Panel](#dashboard), [Katkıda bulunma](#contributing).

## <a id="install-by-asking-your-ai-app"></a>Yapay zekâ uygulamanıza sorarak kurun

Kendiniz hiçbir komut yazmak zorunda değilsiniz. Yapay zekâ uygulamanız bilgisayarınızda komut
çalıştırabiliyorsa (Claude Code, Cursor, VS Code, Windsurf, Gemini CLI ve Codex CLI bunu yapabilir),
kurulumu sizin için o yapabilir. Önce:

1. [TradingView Desktop](https://www.tradingview.com/desktop/) uygulamasını kurun ve oturum açın.
2. Henüz yoksa [Node.js](https://nodejs.org) (LTS sürümü) kurun.

Ardından bu istemi kopyalayın, yapay zekâ uygulamanıza yapıştırın ve gönderin:

```text
Benim için TradingView MCP sunucusunu kur. Bu, tradingview-desktop-mcp adlı npm paketi
(https://github.com/Mochamad-Rizky/tradingview-desktop-mcp). Şu adımları izle ve her birini
bana basit kelimelerle açıkla:

1. Node.js 20.19 veya daha yeni bir sürümün kurulu olduğunu kontrol et. Kurulu değilse dur ve
   bana nasıl kuracağımı anlat.
2. "npx -y tradingview-desktop-mcp config <client>" komutunu çalıştır; <client> şu anda içinde
   çalıştığın uygulama olsun (claude-code, cursor, vscode, windsurf, gemini-cli veya codex-cli).
   Sunucuyu yapılandırmama eklemek için komutun yazdırdığı talimatları uygula ve orada zaten
   bulunan diğer sunucuları koru.
3. TradingView'i "npx -y tradingview-desktop-mcp launch" ile başlat. TradingView'in hata ayıklama
   portu olmadan zaten çalıştığını söylerse önce bana sor ve ancak ben kabul edersem --restart ile
   yeniden çalıştır, çünkü bu TradingView'i kapatır ve kaydedilmemiş değişikliklerimi kaybedebilirim.
4. "npx -y tradingview-desktop-mcp doctor" komutunu çalıştır ve tüm kontrollerin geçip geçmediğini
   söyle. Grafik kontrolü başarısız olursa TradingView'de grafik sekmesini öne getirmemi söyle.
5. TradingView araçları görünmeden önce seni yeniden başlatmam ya da yeni bir sohbet açmam gerekip
   gerekmediğini söyle.
```

İş bittiğinde, size söylendiyse uygulamayı yeniden başlatın ya da yeni bir sohbet açın ve "TradingView'in
bağlı olduğunu kontrol et." diye sorun. Ardından [aşağıdaki istemleri](#try-these-prompts) deneyin.

Claude Desktop mı kullanıyorsunuz? Komut çalıştıramaz, ancak Claude Code, Cursor ve yukarıdaki diğer
uygulamalar kurulumu sizin için yapabilir: istemin sonuna "Bu uygulama için değil, Claude Desktop için
kur (config claude-desktop)." ekleyin. ChatGPT ve OpenAI API bir tünel gerektirir; bunu elle
kurarsınız (bkz. [Uzak istemciler ve tüneller](#remote-clients-and-tunnels)). Asistan takılırsa
aşağıdaki adımları kendiniz izleyin.

## <a id="install"></a>Kurulum

Gerekenler:

- Kurulu ve oturum açılmış TradingView Desktop.
- `npx` komutunu sağlayan Node.js 20.19 veya daha yenisi.

Başka hiçbir şey kurulmaz: aşağıdaki istemciler sunucuyu `npx -y tradingview-desktop-mcp` ile başlatır,
bu da paketi ilk kullanımda indirir. TradingView'i hata ayıklama portuyla başlatın. `launch` komutu
uygulamayı bulur ve bu şekilde başlatır:

```sh
npx -y tradingview-desktop-mcp launch
```

TradingView yalnızca tek bir örneğe izin verir. Uygulama hata ayıklama portu olmadan zaten çalışıyorsa
`launch` durur ve bunu bildirir; `launch --restart` uygulamayı nazikçe kapatır ve portla yeniden
başlatır, TradingView ise önce değişiklikleri kaydetmenizi isteyebilir. Sunucunun uygulamaya
ulaşabildiğini kontrol edin:

```sh
npx -y tradingview-desktop-mcp doctor
```

Grafik sekmesi arka plandayken, yani Yeni sekme sayfasının ya da grafiği olmayan başka bir sekmenin
arkasındayken `doctor` grafik kontrolünde başarısız olur; bu yüzden grafik sekmesini öne getirin.
`npx -y tradingview-desktop-mcp --help` seçenekleri, [.env.example](../../.env.example) ise ortam
değişkenlerini listeler.

## <a id="connect-your-ai-app"></a>Yapay zekâ uygulamanızı bağlayın

`config <client>` bir istemcinin yapılandırma parçacığını yazdırır ve nereye ekleneceğini söyler.
Aşağıdaki her eğitim aynı parçacığı, o uygulamaya özgü adımları ve çalışmadığında ne yapılacağını içerir.

| İstemci                                        | Parçacığı yazdır                                       |
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

Varsayılan aktarım stdio'dur; burada stdout yalnızca MCP mesajlarını taşır, günlükler ise stderr'e
gider. İlk yedi istemci sunucuyu kendisi başlatır. Windows'ta `npx` komutunu doğrudan başlatamayan bir
istemci `cmd /c npx` biçimine ihtiyaç duyar; `config` bunu Windows'ta çalıştığında (ya da
`--platform win32` ile) yazdırır. `--profile` bir [araç profilini](#tool-profiles) sunucuya iletir.

### <a id="remote-clients-and-tunnels"></a>Uzak istemciler ve tüneller

ChatGPT ve OpenAI API bilgisayarınızda program başlatamaz. Sunucuya herkese açık bir HTTPS adresinden
ulaşırlar; bu yüzden sunucuyu HTTP üzerinden çalıştırır ve önüne bir tünel koyarsınız. Bu, oturum
açılmış TradingView'inizi kontrol edebilen bir sunucuyu internete açar: `--profile readonly`, güçlü
bir token (`TV_MCP_AUTH_TOKEN`), `--allowed-hosts` içinde tünelin herkese açık host adı
(`TV_MCP_ALLOWED_HOSTS`) ve panelin dosyaları tünel üzerinden sunulmasın diye `--no-dashboard`
kullanın. [ChatGPT](../clients/chatgpt.md) ve [OpenAI API](../clients/openai-api.md) eğitimleri
bunu adım adım anlatır, [SECURITY.md](../../SECURITY.md#tunnels-and-remote-clients) ise salt okunur bir
token'ın yine de nelere erişebildiğini listeler.

## <a id="quick-start-from-source"></a>Kaynaktan hızlı başlangıç

Yayımlanmış paket yerine bir checkout çalıştırmak için sunucuyu derlemek üzere Node.js 24'e
(`nvm use`, `.nvmrc` dosyasını okur) ve sürümünü `package.json` dosyasının sabitlediği
[pnpm](https://pnpm.io) aracına ihtiyacınız var. Derlenmiş sunucu Node.js 20.19 veya daha yenisinde
çalışır.

```sh
git clone https://github.com/Mochamad-Rizky/tradingview-desktop-mcp.git
cd tradingview-desktop-mcp
pnpm install && pnpm build
node packages/server/dist/cli.js launch
node packages/server/dist/cli.js doctor
```

`node packages/server/dist/cli.js config <client> --local`, bir istemcinin bu checkout için
parçacığını, `npx` yerine `node` ve `cli.js` dosyasının mutlak yolu ile yazdırır. JSON yapılandırması
kullanan bir istemci için girdi şöyle görünür:

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

Bir HTTP aktarımı da vardır (`--transport http`); kullanmadan önce [SECURITY.md](../../SECURITY.md)
dosyasını okuyun.

## <a id="use-it"></a>Kullanım

Bir MCP istemcisini yukarıda anlatıldığı gibi bağlayın, TradingView hata ayıklama portuyla çalışırken
istediğinizi sade bir dille isteyin. Araçları asistan seçer ve çağırır, bu yüzden adlarını bilmeniz
gerekmez. [Araç başvurusu](../tools.md) her aracı girdileriyle ve ait olduğu profillerle birlikte
listeler.

### <a id="try-these-prompts"></a>Bu istemleri deneyin

Aşağıdaki her istem, [docs/examples.md](../examples.md) içindeki örneklerden biridir. Bu dosya
asistanın yaptığı araç çağrılarını ve sonuçlarını gösterir; üç öğeden uzun listeler kısaltılmış, her
çağrının süresi (`durationMs`) çıkarılmış ve ekran görüntüleri gösterilmek yerine bir notta
adlandırılmıştır. Alıntılar bu sonuçların satırlarıdır; `…`, bir sonucun diğer bölümlerine ait
satırların çıkarıldığı yeri işaret eder. Değerler yapaydır: uydurma bir NASDAQ:AAPL grafiğine sahip
sahte bir TradingView uygulamasından gelirler; yani hiçbiri piyasa verisi değildir ve hiçbiri bir
hesaptan gelmez. Sonuçlar sunucunun verdiği biçimdedir, ancak geriye dönük test örneğinin arkasındaki
Strategy Tester raporu henüz gerçek uygulamadan okunmamıştır.

**"Grafiğimde neye bakıyorum? Sembolü, zaman dilimini ve üzerinde hangi indikatörlerin olduğunu
söyle."** Asistan grafiği `chart_get_state` ile okur
([ayrıntılar](../examples.md#1-read-the-chart)):

```json
"symbol": "NASDAQ:AAPL",
"resolution": "1D",
"chartTypeName": "candles",
```

**"Bana son 3 günlük mumu göster."** Çubukları `data_get_ohlcv` ile okur
([ayrıntılar](../examples.md#3-read-the-last-candles)):

```json
"timeIso": "2024-10-27T00:00:00Z",
"open": 103.58,
"close": 103.42,
```

**"Grafiğime MACD ekle."** Planın izin verdiği kadar indikatör taşıyan bir grafikte `indicator_add`
hiçbir şey eklemez ve sınırı bildirir; yer açmak için indikatörlerinizden birini kaldırmak ise
onayınızı gerektirir ([ayrıntılar](../examples.md#5-add-an-indicator-to-a-full-chart)):

```json
"code": "PLAN_LIMIT",
"message": "The chart holds as many indicators as the plan allows (2)",
```

**"Kapanış fiyatının 9 ve 21 çubukluk hareketli ortalamalarını çizen bir Pine Script indikatörü yaz
ve derlendiğini kontrol et."** Betiği `pine_new` ile Pine Editor'a koyar ve `pine_compile` ile derler
([ayrıntılar](../examples.md#6-write-and-compile-a-pine-script)):

```json
"success": true,
"errors": [],
"warnings": [],
```

**"Pine Editor'daki betiğim derlenmiyor. Düzeltebilir misin?"** `pine_smart_compile` betiği derler,
bildiği hatalar için kural tabanlı düzeltmeler uygular (örneğin bir v6 betiğindeki Pine v4 adları) ve
editörü değiştirmeden yeniden derler
([ayrıntılar](../examples.md#7-fix-a-pine-script-with-smart-compile)):

```json
"message": "Could not find function or function reference 'study'",
…
"applied": ["Replace study( with indicator(", "Replace rsi( with ta.rsi("]
…
"writtenBack": false
```

**"Grafiğimdeki strateji geriye dönük testte nasıl performans gösterdi?"** Strategy Tester'ı
`strategy_get_results` ve `strategy_get_trades` ile okur
([ayrıntılar](../examples.md#8-read-backtest-results)):

```json
"netProfit": 155,
"totalTrades": 3,
"percentProfitable": 66.67,
"profitFactor": 4.1,
```

**"Grafiğime 102.80 seviyesinde bir destek çizgisi çiz."** `drawing_create` ile yatay bir çizgi çizer;
`drawing_list` bu çizgiyi sizin kendi çizimlerinizin yanında, bu oturum tarafından çizildi olarak
işaretlenmiş şekilde gösterir ([ayrıntılar](../examples.md#9-draw-a-support-line)):

```json
"id": "DRW001",
"shape": "horizontal_line",
"text": "Support",
"createdByServer": true
```

**"Apple 110'u geçtiğinde bana alarm ver."** `alert_create`, TradingView hesabınızda bir fiyat alarmı
kurar ([ayrıntılar](../examples.md#10-create-a-price-alert)). Plan zaten izin verdiği kadar alarm
içeriyorsa hiçbir şey oluşturmaz ve sınırı bildirir; `alert_list` ise planı dolduran alarmları
gösterir ([ayrıntılar](../examples.md#11-create-an-alert-when-the-plan-is-full)):

```json
"symbol": "NASDAQ:AAPL",
"condition": "crossing",
"price": 110,
"expirationIso": "2024-11-26T00:00:00Z"
```

**"Şu sembolleri izleme listeme ekle: NYSE:IBM, FX:EURUSD, NASDAQ:MSFT ve NASDAQ:MSTF."**
`watchlist_add_bulk` her sembolü TradingView'in sembol aramasıyla kontrol eder, yenilerini ekler ve
diğerlerini neden atladığını söyler ([ayrıntılar](../examples.md#12-add-symbols-to-a-watchlist)):

```json
"added": ["NYSE:IBM", "FX:EURUSD"],
…
{ "symbol": "NASDAQ:MSFT", "reason": "already_listed" },
{ "symbol": "NASDAQ:MSTF", "reason": "unknown" }
```

**"Grafiğimin 2024-06-03 tarihinden başlayan bar replay'i üzerinde pratik yapayım: beş çubuk ileri git,
nerede olduğumuzu söyle, sonra replay'i bitir."** Bar replay'i `replay_start` ile başlatır,
`replay_step` ile ilerler, replay'in nerede olduğunu `replay_status` ile okur ve `replay_stop` ile
çıkar. Hiçbir işlem yapılmaz: hiçbir araç emir vermez
([ayrıntılar](../examples.md#13-practice-with-bar-replay)):

```json
"dateIso": "2024-06-07T00:00:00Z",
"stepped": 5,
…
"position": null,
"realizedPL": null
```

**"Grafiğimin ekran görüntüsünü al."** `screenshot_capture` resmi boyutuyla birlikte asistana görüntü
olarak verir ve diske hiçbir şey yazmaz
([ayrıntılar](../examples.md#14-take-a-screenshot)):

```json
"data": { "target": "chart", "format": "jpeg", "width": 1180, "height": 640, "bytes": 3100 },
"meta": { "via": "cdp", "warnings": [] }
```

Sunucu ayrıca kendine ait beş istem sunar; MCP istemlerini destekleyen bir istemci bunları seçmeniz
için listeler: `analyze_current_chart`, `multi_timeframe_review`, `write_and_backtest_strategy`,
`debug_pine_script` ve `replay_practice_session`. Her biri asistana hangi araçları hangi sırayla
çağıracağını ve neyi raporlayacağını söyler. `replay_practice_session`, bar replay üzerinde bir pratik
oturumu yürütür: asistan geçmişte çubuk çubuk ilerler, her adımda size long mu, short mu açacağınızı
yoksa pozisyonsuz mu kalacağınızı sorar, bu varsayımsal işlemlerin günlüğünü grafikten okuduğu
fiyatlarla tutar ve kâr ya da zararlarını hesaplar. Önce sizin bir replay'inizin çalışıp çalışmadığını
kontrol eder ve bir şeyi değiştirmeden önce onunla ne yapılacağını size sorar; sonunda kendi başlattığı
replay'i durdurur, sizinkilerden hiçbirini asla durdurmaz.

### <a id="safety"></a>Güvenlik

Grafiğinizi, betiklerinizi veya hesabınızı değiştiren araçlar, zaten size ait olan şeylere karşı
dikkatlidir. Pine Editor'daki kaydedilmemiş metni değiştirmek (sunucunun bu oturumunun orada kendisi
yaptığı kaydedilmemiş bir düzenleme hariç), bu oturumun oluşturmadığı bir betiğin yeni bir sürümünü
kaydetmek ve grafiğinizde zaten bulunan bir indikatörü kaldırmak, `confirm: true` gerektirir; asistan
bunu yalnızca siz kabul ettikten sonra iletmelidir. Aynısı şunlar için de geçerlidir: bu oturumun
oluşturmadığı, eklemediği veya açmadığı bir çizimi, alarmı, izleme listesi sembolünü veya sekmeyi
kaldırmak; bir grafiğin tüm çizimlerini kaldırmak; kaydedilmemiş değişiklikleri olan bir düzenden
başka bir düzene geçmek ve sekmenin gösterdiğinden daha az grafik içeren, bir sonraki kaydı diğer
grafikleri silecek bir çoklu grafik düzenine geçmek. Bir grafikteki indikatör sayısı, kayıtlı betik
sayısı, alarm sayısı ya da bir düzendeki grafik sayısı gibi bir plan sınırı, herhangi bir şey
eklenmeden önce kontrol edilir ve sınırla birlikte bir `PLAN_LIMIT` hatası olarak bildirilir; sınır
sizin TradingView sürümünüzde okunamıyorsa araç hiçbir şey yapmaz ve bunu söyler. Sunucu bir sınırın
etrafından dolaşmaz. Araçlar TradingView'in yükseltme iletişim kutusunu ya da kendine ait başka bir
iletişim kutusunu açmasına neyin yol açacağını önceden kontrol eder ve bunun yerine reddeder, ancak bu
kontrollerin öngöremediği birkaç uyarı kalır: `layout_switch`, daha az grafiğe izin veren bir plandaki
kayıtlı bir çoklu grafik düzeni için, TradingView sunucusunun sınırı aşıyor diye reddettiği bir düzen
için ve TradingView'in kendisi için tuttuğu listenin sınırı aşmış olarak işaretlediği ama
`layout_list`'in işaretlemediği bir düzen için bir yükseltme uyarısıyla karşılaşabilir; `layout_new`,
TradingView kontrollerden sonra yeni düzeni reddettiğinde onun bir mesajıyla karşılaşabilir; `tab_close` ise düzeninde kaydedilmemiş değişiklik olup olmadığını TradingView'in beklediğinden daha
uzun sürede bildiren ya da devam eden bir kayıt bildiren bir sayfa için "Close tab?" iletişim kutusuyla
karşılaşabilir. Düşük seviyeli `ui_*` araçları istediğiniz yere tıklar ve istediğinizi yazar, bu
yüzden tasarım gereği TradingView'in iletişim kutularını açabilirler. Sunucu hiçbir betiği silmez ve
yeniden adlandırmaz.

Hiçbir araç emir vermez: bar replay pratik içindir ve asistan pratik işlemlerini sohbette tutar.
Ekran görüntüleri istemciye görüntü olarak gider ve sunucu diske hiçbirini yazmaz. Grafik sayfasında
JavaScript çalıştıran `ui_evaluate`, sunucuyu `--allow-eval` (`TV_MCP_ALLOW_EVAL=true`) ile
başlatmadığınız sürece kapalıdır.

### <a id="tool-profiles"></a>Araç profilleri

Varsayılan olarak sunucu 83 aracının tamamını sunar (`--profile full`). Bazı istemciler yalnızca
sınırlı sayıda aracı kabul eder (Cursor 40'ın üzerinde uyarı verir). Bunlar için `--profile core` 40
temel araçtan oluşan küçültülmüş bir küme, `--profile readonly` ise yalnızca okuma yapan 37 aracı
sunar. `--tools`, `chart_*,data_*` gibi ad kalıpları alır ve profili daha da daraltır: bir araç hem
profilde olmalı hem de bir kalıpla eşleşmelidir; bu yüzden `--profile core --tools 'pine_*'`, temel
araçlar arasında olmayan `pine_open` ve `pine_save` araçlarını yine dışarıda bırakır. Varsayılan
profilde araçları tek başına `--tools` seçer. Bazı açıklamalar ve ipuçları, `core` profilinin dışarıda
bıraktığı `pine_open` ve `pine_save` gibi araçları anar; asistan `core` altında bunları çağıramaz.
Kaynaklar araçları izler: her biri yalnızca verisini paylaştığı araçla birlikte sunulur, örneğin
`tradingview://pine/source` kaynağı `pine_get_source` ile; bu yüzden `--tools 'chart_*'` grafik
durumunu sunar ama Pine Editor'dan hiçbir şey sunmaz.

[Araç başvurusu](../tools.md) her aracı girdileriyle ve ait olduğu profillerle birlikte listeler.

## <a id="troubleshooting"></a>Sorun giderme

[docs/troubleshooting.md](../troubleshooting.md) her hata kodunu ve TradingView bulunamadığında,
hata ayıklama portu meşgul olduğunda, bir istemci araçları göstermediğinde ya da bir tünel bir isteği
reddettiğinde ne yapılacağını açıklar. İlk çalıştırılacak şey `npx -y tradingview-desktop-mcp doctor`
komutudur.

## <a id="dashboard"></a>Panel

Sunucu, asistanınızın ne yaptığını izlemek ve bir aracı elle denemek için bir web paneliyle gelir.
Ek bir kurulum gerektirmez: yayımlanan paket onu içerir, `pnpm build` ise onu bir checkout'un
sunucusuna derler.

![Durum sayfası: bir grafik bulunmuş ve uygulama hazır halde erişilebilir TradingView, sunucuya ait bilgiler ve plan sınırları](../images/dashboard-status.png)

### <a id="open-it"></a>Açma

- **HTTP aktarımı:** sunucuyu bir token ile başlatın ve `http://127.0.0.1:8787/` adresini açın. Panel
  bu modda varsayılan olarak açıktır; `--no-dashboard` (`TV_MCP_DASHBOARD=false`) onu kapatır.

  ```sh
  TV_MCP_AUTH_TOKEN="$(openssl rand -hex 32)" npx -y tradingview-desktop-mcp --transport http
  ```

  Bir checkout'tan bunun yerine `node packages/server/dist/cli.js --transport http` çalıştırın.

- **stdio ile birlikte:** sunucuyu stdio üzerinden başlatan bir MCP istemcisi de bir panele sahip
  olabilir. Yapılandırmasına `--dashboard` (`TV_MCP_DASHBOARD=true`) ve `TV_MCP_AUTH_TOKEN` ekleyin.
  Panel kendi adresinde dinler (`--host` ve `--port` ayarlamadığınız sürece `127.0.0.1:8787`) ve
  `/mcp` sunmaz. Token olmadan ya da port doluysa panel kapalı kalır ve sunucu bir uyarı günlüğe
  yazar, ancak MCP sunucusu çalışmaya devam eder. İstemcinin yaptığı çağrılar canlı günlükte görünür.

Sunucu başlarken panelin adresini stderr'e yazdırır. Token'ı asla yazdırmaz.

### <a id="the-token"></a>Token

Sayfa herhangi bir şey göstermeden önce token'ı (`TV_MCP_AUTH_TOKEN`) ister. Onu yapıştırın ya da
`http://127.0.0.1:8787/#token=<token>` adresini bir kez açın: sayfa token'ı fragment'tan okur ve
adresten kaldırır; fragment ise sunucuya hiçbir zaman gönderilmez. Sayfa token'ı `sessionStorage`
içinde tutar, böylece sekmeyi kapattığınızda silinir ve token'ı asla bir URL içinde değil, yalnızca
`Authorization: Bearer <token>` olarak gönderir. Sunucu başka bir token ile yeniden başladığında sayfa
yeniden sorar. Bkz. [SECURITY.md](../../SECURITY.md#the-dashboard).

### <a id="what-it-shows"></a>Neler gösterir

![Canlı günlük: en yenisi en üstte olacak şekilde, zamanı, aracı, kaynağı, durumu ve süresiyle araç çağrılarının tablosu ve üstünde arama ile filtreler](../images/dashboard-log.png)

- **Status**, TradingView'e erişilip erişilemediğini (erişilemiyorsa nasıl başlatılacağını), sunucunun
  nasıl çalıştığını, plan sınırlarını ve en son çağrıları gösterir.
- **Log**, sunucunun çalıştırdığı her araç çağrısını, ister bir MCP istemcisi ister panel yapmış olsun,
  araç adına göre filtre, duraklatma, temizleme ve her çağrının ayrıntılarıyla birlikte akış olarak
  gösterir. Bağlantı koptuktan sonra "Reconnecting…" der ve kaldığı yerden devam eder. Panelin açık
  her sekmesi sunucuya bir olay akışı tutar ve bir tarayıcı tek bir host'a yaklaşık altı bağlantıya
  izin verir; bu yüzden çok sayıda panel sekmesi açıkken yeni bir sekme boş bir bağlantı bekleyebilir:
  kullanmadığınız sekmeleri kapatın.
- **Tools**, sunucunun sunduğu araçları girdileriyle birlikte listeler ve birini elle çalıştırır.
  Sonuç geldiği gibi gösterilir; uzun JSON "Show all" arkasına daraltılır, görüntüler görüntü olarak
  gösterilir.

![Araçlar sayfası: solda arama ve filtreleriyle araç listesi, sağda açıklaması, bilgileri ve girdi alanlarıyla chart_get_state](../images/dashboard-tools.png)

Panelden yapılan bir çalıştırma gerçek bir araç çağrısıdır. Bir MCP çağrısıyla aynı kayıt
defterinden geçer; bu yüzden aynı şemalar, profil, `confirm` kuralları ve plan sınırı kontrolleri
geçerlidir ve çağrı günlükte görünür. Panel, salt okunur olmayan herhangi bir aracı çalıştırmadan önce
onay ister.

### <a id="the-api"></a>API

Sayfa sunucuyla küçük bir API üzerinden konuşur; bu API'yi `curl` ve token ile siz de
çağırabilirsiniz. Her rota `Authorization: Bearer <token>` gerektirir ve sunucu, `/mcp` için yaptığı
gibi `Host` ve `Origin` başlıklarını kontrol eder.

| Rota                     | Ne yapar                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `GET /api/info`          | Sürüm, aktarım, profil, araç sayısı ve başlangıç zamanı                                             |
| `GET /api/health`        | Sağlık raporu: TradingView'e erişilip erişilemediği                                                 |
| `GET /api/tools`         | Sunulan araçlar, şemaları ve ek açıklamalarıyla birlikte                                            |
| `POST /api/tools/<name>` | Bir aracı `{"arguments": {...}}` ile, `dashboard` kaynağı olarak çalıştırır                         |
| `GET /api/events`        | Araç çağrılarının server-sent events akışı; `?limit=` kaç tanesinin yeniden oynatılacağını belirler |

Sayfanın kendi dosyaları, `/` adresinde, token gerektirmez ve veri içermez.

## <a id="contributing"></a>Katkıda bulunma

Yerel kurulum, test seviyeleri, commit kuralları ve bir sürümün nasıl yayımlandığı için
[CONTRIBUTING.md](../../CONTRIBUTING.md) dosyasına, test rehberi için [docs/testing.md](../testing.md)
dosyasına bakın. Bir güvenlik açığı bildirmek için [SECURITY.md](../../SECURITY.md) dosyasını izleyin.

## <a id="disclaimer"></a>Sorumluluk reddi

Bu proje TradingView, Inc. ile bağlantılı değildir, onun tarafından onaylanmamış veya
desteklenmemiştir. TradingView, sahibinin ticari markasıdır. Buradaki hiçbir şey finansal tavsiye
değildir. Araçlar uygulamanın gösterdiklerini değiştirir ve kontrollerine erişebilir; bu yüzden neyi
otomatikleştirdiğinizden ve TradingView'in kullanım koşullarına uymaktan siz sorumlusunuz.

## <a id="license"></a>Lisans

[MIT lisansı](../../LICENSE) altında yayımlanmıştır.
