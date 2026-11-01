# tradingview-desktop-mcp

[English](../../README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Türkçe](README.tr.md) · [Русский](README.ru.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Українська](README.uk.md) · [Polski](README.pl.md) · [Português (Brasil)](README.pt-BR.md) · [العربية](README.ar.md) · [فارسی](README.fa.md) · **Bahasa Indonesia** · [Italiano](README.it.md) · [Ελληνικά](README.el.md) · [മലയാളം](README.ml.md) · [Roman Urdu](README.ur-Latn.md) · [Română](README.ro.md)

[![npm](https://img.shields.io/npm/v/tradingview-desktop-mcp)](https://www.npmjs.com/package/tradingview-desktop-mcp)
[![CI](https://github.com/Mochamad-Rizky/tradingview-desktop-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Mochamad-Rizky/tradingview-desktop-mcp/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/Mochamad-Rizky/tradingview-desktop-mcp/graph/badge.svg)](https://codecov.io/gh/Mochamad-Rizky/tradingview-desktop-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../../LICENSE)

> Ini adalah terjemahan dari [README berbahasa Inggris](../../README.md). Jika keduanya berbeda, versi bahasa Inggris yang menjadi acuan.

<p align="center">
  <a href="../media/promo.mp4"><img src="../media/teaser.gif" width="49%" alt="Video ringkasan: asisten membaca chart, menggambar garis support, menulis Pine Script, dan memasang alert harga"></a>
  <a href="../media/tutorial.mp4"><img src="../media/tutorial-poster.jpg" width="49%" alt="Tutorial penyiapan: siapkan dalam lima langkah"></a>
</p>

<p align="center">
  <a href="../media/promo.mp4"><b>▶ Tonton ringkasannya</b></a> (0:48) &nbsp;·&nbsp;
  <a href="../media/tutorial.mp4"><b>▶ Tonton tutorial penyiapan</b></a> (1:53)<br>
  <sub>Kedua video memakai chart rekaan, bukan data pasar.</sub>
</p>

Server [MCP](https://modelcontextprotocol.io) yang memungkinkan asisten AI membaca dan mengendalikan
aplikasi TradingView Desktop di komputer Anda sendiri. Server ini mengendalikan aplikasi yang sudah
Anda gunakan untuk login melalui Chrome DevTools Protocol, lewat port debug yang dibuka aplikasi saat
dijalankan dengan `--remote-debugging-port`. Server ini hanya mengotomatiskan aplikasi lokal: ia tidak
login atas nama Anda, tidak mengakali batas paket, dan tidak memanggil server TradingView.

> **Status: pra-1.0.** Nama tool dan opsinya bisa berubah sebelum 1.0. Instal paketnya dari npm,
> seperti di bawah, atau jalankan server [dari source](#quick-start-from-source). Sudah dicoba di
> macOS; Windows dan Linux didukung sebisanya.

Server ini menyediakan tool aplikasi (launch, health, discovery, status antarmuka, batas paket,
reconnect), tool chart (state, simbol, timeframe, tipe chart, rentang yang terlihat, scrolling), tool
data pasar (bar, kuotasi, info dan pencarian simbol), tool indikator (daftar, cari, tambah, hapus,
input, visibilitas, nilai), tool Pine Script (editor dan skrip tersimpan, compile, smart compile
dengan perbaikan berbasis aturan, analisis offline, konsol, serta garis, label, kotak, dan tabel yang
digambar skrip), tool Strategy Tester (hasil, trade, equity), tool gambar, alert, dan watchlist, tool
layout, multi-chart, dan tab, bar replay, screenshot, tool antarmuka tingkat rendah (klik, hover,
mengetik, tombol, scroll, cari, panel, layar penuh, dan JavaScript di halaman chart bila Anda
mengizinkannya), serta `batch_run`, yang menjalankan beberapa tool dalam satu panggilan. Server ini
juga menyediakan resource (health aplikasi, state dan bar chart, source Pine dan hasil compile
terakhir, laporan strategi, watchlist aktif), masing-masing bersama tool yang berbagi data dengannya,
serta lima prompt untuk pekerjaan umum. Dashboard web menampilkan panggilan secara langsung dan bisa
menjalankan tool secara manual (lihat [Dashboard](#dashboard)).

Isi: [Instal dengan meminta aplikasi AI Anda](#install-by-asking-your-ai-app), [Instalasi](#install),
[Hubungkan aplikasi AI Anda](#connect-your-ai-app), [Klien remote dan tunnel](#remote-clients-and-tunnels),
[Mulai cepat dari source](#quick-start-from-source), [Penggunaan](#use-it),
[Pemecahan masalah](#troubleshooting), [Dashboard](#dashboard), [Kontribusi](#contributing).

## <a id="install-by-asking-your-ai-app"></a>Instal dengan meminta aplikasi AI Anda

Anda tidak perlu mengetik perintah apa pun sendiri. Jika aplikasi AI Anda bisa menjalankan perintah
di komputer Anda, seperti Claude Code, Cursor, VS Code, Windsurf, Gemini CLI, dan Codex CLI, aplikasi
itu bisa melakukan penyiapan untuk Anda. Pertama:

1. Instal [TradingView Desktop](https://www.tradingview.com/desktop/) lalu login.
2. Instal [Node.js](https://nodejs.org) (versi LTS), jika belum ada.

Lalu salin prompt ini, tempelkan ke aplikasi AI Anda, dan kirim:

```text
Tolong instal server MCP TradingView untuk saya. Ini adalah paket npm tradingview-desktop-mcp
(https://github.com/Mochamad-Rizky/tradingview-desktop-mcp). Ikuti langkah-langkah berikut dan
jelaskan setiap langkah kepada saya dengan bahasa yang sederhana, dalam bahasa Indonesia:

1. Periksa apakah Node.js 20.19 atau yang lebih baru sudah terinstal. Jika belum, berhenti dan
   beri tahu saya cara menginstalnya.
2. Jalankan "npx -y tradingview-desktop-mcp config <client>", dengan <client> adalah aplikasi
   tempat kamu berjalan (claude-code, cursor, vscode, windsurf, gemini-cli, atau codex-cli).
   Lakukan apa yang dicetaknya untuk menambahkan server ke konfigurasi saya, dan pertahankan
   server lain yang sudah ada di sana.
3. Jalankan TradingView dengan "npx -y tradingview-desktop-mcp launch". Jika muncul pesan bahwa
   TradingView sudah berjalan tanpa port debug, tanyakan saya dulu, dan hanya jika saya setuju,
   jalankan lagi dengan --restart, karena itu akan menutup TradingView dan saya bisa kehilangan
   perubahan yang belum disimpan.
4. Jalankan "npx -y tradingview-desktop-mcp doctor" dan beri tahu saya apakah semua pemeriksaan
   lolos. Jika pemeriksaan chart gagal, minta saya membawa tab chart ke depan di TradingView.
5. Beri tahu saya apakah saya harus me-restart kamu, atau membuka chat baru, sebelum tool
   TradingView muncul.
```

Setelah selesai, restart aplikasinya atau buka chat baru jika diminta, lalu tanyakan "Periksa apakah
TradingView sudah terhubung." Kemudian coba [prompt di bawah ini](#try-these-prompts).

Memakai Claude Desktop? Aplikasi itu tidak bisa menjalankan perintah, tetapi Claude Code, Cursor, dan
aplikasi lain di atas bisa menyiapkannya untuk Anda: tambahkan "Siapkan untuk Claude Desktop (config
claude-desktop), bukan untuk aplikasi ini." di akhir prompt. ChatGPT dan OpenAI API memerlukan tunnel,
yang Anda siapkan secara manual (lihat [Klien remote dan tunnel](#remote-clients-and-tunnels)). Jika
asisten tersendat, ikuti sendiri langkah-langkah di bawah ini.

## <a id="install"></a>Instalasi

Yang Anda perlukan:

- TradingView Desktop, sudah terinstal dan sudah login.
- Node.js 20.19 atau yang lebih baru, yang menyediakan `npx`.

Tidak ada lagi yang perlu diinstal: klien di bawah menjalankan server dengan
`npx -y tradingview-desktop-mcp`, yang mengunduh paketnya saat pertama kali dipakai. Jalankan
TradingView dengan port debug-nya. Perintah `launch` menemukan aplikasinya dan menjalankannya dengan
cara itu:

```sh
npx -y tradingview-desktop-mcp launch
```

TradingView hanya mengizinkan satu instance. Jika aplikasi sudah berjalan tanpa port debug, `launch`
berhenti dan memberi tahu Anda; `launch --restart` menutupnya dengan baik-baik lalu menjalankannya
lagi dengan port tersebut, dan TradingView mungkin meminta Anda menyimpan perubahan terlebih dahulu.
Periksa apakah server bisa menjangkau aplikasi:

```sh
npx -y tradingview-desktop-mcp doctor
```

Pemeriksaan chart pada `doctor` gagal selama tab chart berada di belakang, di balik halaman New tab
atau tab lain tanpa chart, jadi bawa tab chart ke depan.
`npx -y tradingview-desktop-mcp --help` menampilkan daftar opsi, dan [.env.example](../../.env.example)
berisi variabel lingkungannya.

## <a id="connect-your-ai-app"></a>Hubungkan aplikasi AI Anda

`config <client>` mencetak potongan konfigurasi untuk sebuah klien dan memberi tahu di mana harus
menaruhnya. Setiap tutorial di bawah memuat potongan yang sama, langkah-langkah untuk aplikasi
tersebut, dan apa yang harus dilakukan jika tidak berhasil.

| Klien                                          | Cetak potongan konfigurasinya                          |
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

Transport bawaan adalah stdio, di mana stdout hanya membawa pesan MCP dan log masuk ke stderr. Tujuh
klien pertama menjalankan server sendiri. Di Windows, klien yang tidak bisa menjalankan `npx` secara
langsung memerlukan bentuk `cmd /c npx`, yang dicetak oleh `config` saat dijalankan di Windows (atau
dengan `--platform win32`). `--profile` meneruskan [profil tool](#tool-profiles) ke server.

### <a id="remote-clients-and-tunnels"></a>Klien remote dan tunnel

ChatGPT dan OpenAI API tidak bisa menjalankan program di komputer Anda. Keduanya menjangkau server
lewat alamat HTTPS publik, jadi Anda menjalankan server lewat HTTP dan memasang tunnel di depannya.
Artinya, server yang bisa mengendalikan TradingView Anda yang sedang login terekspos ke internet:
gunakan `--profile readonly`, token yang kuat (`TV_MCP_AUTH_TOKEN`), host publik tunnel di
`--allowed-hosts` (`TV_MCP_ALLOWED_HOSTS`), dan `--no-dashboard`, agar file dashboard tidak disajikan
melalui tunnel. Tutorial untuk [ChatGPT](../clients/chatgpt.md) dan
[OpenAI API](../clients/openai-api.md) menjelaskannya langkah demi langkah, dan
[SECURITY.md](../../SECURITY.md#tunnels-and-remote-clients) mencantumkan apa saja yang masih bisa dijangkau
oleh token read-only.

## <a id="quick-start-from-source"></a>Mulai cepat dari source

Untuk menjalankan hasil checkout alih-alih paket yang dipublikasikan, Anda memerlukan Node.js 24
untuk mem-build server (`nvm use` membaca `.nvmrc`) dan [pnpm](https://pnpm.io), yang versinya
dikunci oleh `package.json`. Server hasil build berjalan di Node.js 20.19 atau yang lebih baru.

```sh
git clone https://github.com/Mochamad-Rizky/tradingview-desktop-mcp.git
cd tradingview-desktop-mcp
pnpm install && pnpm build
node packages/server/dist/cli.js launch
node packages/server/dist/cli.js doctor
```

`node packages/server/dist/cli.js config <client> --local` mencetak potongan konfigurasi sebuah klien
untuk checkout ini, dengan `node` dan path absolut `cli.js` sebagai pengganti `npx`. Untuk klien
dengan konfigurasi JSON, entrinya terlihat seperti ini:

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

Ada juga transport HTTP (`--transport http`); baca [SECURITY.md](../../SECURITY.md) sebelum Anda
menggunakannya.

## <a id="use-it"></a>Penggunaan

Hubungkan klien MCP seperti dijelaskan di atas, dengan TradingView berjalan menggunakan port
debug-nya, lalu minta apa yang Anda inginkan dengan bahasa sehari-hari. Asisten akan memilih tool dan
memanggilnya, jadi Anda tidak perlu tahu nama-namanya. [Referensi tool](../tools.md) mencantumkan
setiap tool beserta input-nya dan profil tempat tool itu berada.

### <a id="try-these-prompts"></a>Coba prompt berikut

Setiap prompt di bawah adalah salah satu contoh di [docs/examples.md](../examples.md), yang
menunjukkan panggilan tool yang dilakukan asisten beserta hasilnya, dengan daftar yang lebih dari
tiga item dipotong, durasi setiap panggilan (`durationMs`) dihilangkan, dan screenshot hanya disebut
dalam catatan alih-alih ditampilkan. Kutipan di bawah adalah baris-baris dari hasil tersebut, dan `…`
menandai tempat baris dari bagian lain sebuah hasil dihilangkan. Nilainya sintetis: berasal dari
aplikasi TradingView palsu dengan chart NASDAQ:AAPL rekaan, jadi tidak ada yang merupakan data pasar
dan tidak ada yang berasal dari akun; hasilnya memiliki bentuk seperti yang diberikan server, meski
laporan Strategy Tester di balik contoh backtest belum dibaca dari aplikasi aslinya.

**"Apa yang sedang saya lihat di chart saya? Sebutkan simbolnya, timeframe-nya, dan indikator apa saja
yang ada di sana."** Asisten membaca chart dengan `chart_get_state`
([detail](../examples.md#1-read-the-chart)):

```json
"symbol": "NASDAQ:AAPL",
"resolution": "1D",
"chartTypeName": "candles",
```

**"Tampilkan 3 candle harian terakhir."** Asisten membaca bar dengan `data_get_ohlcv`
([detail](../examples.md#3-read-the-last-candles)):

```json
"timeIso": "2024-10-27T00:00:00Z",
"open": 103.58,
"close": 103.42,
```

**"Tambahkan MACD ke chart saya."** Pada chart yang sudah memuat indikator sebanyak yang diizinkan
paket, `indicator_add` tidak menambahkan apa pun dan melaporkan batasnya, dan menghapus salah satu
indikator Anda untuk memberi ruang memerlukan konfirmasi Anda
([detail](../examples.md#5-add-an-indicator-to-a-full-chart)):

```json
"code": "PLAN_LIMIT",
"message": "The chart holds as many indicators as the plan allows (2)",
```

**"Tulis indikator Pine Script yang memplot moving average 9 bar dan 21 bar dari harga close, lalu
periksa apakah skripnya bisa di-compile."** Asisten menaruh skrip di Pine Editor dengan `pine_new` dan
meng-compile-nya dengan `pine_compile` ([detail](../examples.md#6-write-and-compile-a-pine-script)):

```json
"success": true,
"errors": [],
"warnings": [],
```

**"Skrip di Pine Editor saya tidak mau di-compile. Bisa tolong perbaiki?"** `pine_smart_compile`
meng-compile skrip, menerapkan perbaikan berbasis aturan untuk error yang dikenalinya, seperti nama
Pine v4 di skrip v6, lalu meng-compile lagi, tanpa mengubah isi editor
([detail](../examples.md#7-fix-a-pine-script-with-smart-compile)):

```json
"message": "Could not find function or function reference 'study'",
…
"applied": ["Replace study( with indicator(", "Replace rsi( with ta.rsi("]
…
"writtenBack": false
```

**"Bagaimana hasil backtest strategi di chart saya?"** Asisten membaca Strategy Tester dengan
`strategy_get_results` dan `strategy_get_trades`
([detail](../examples.md#8-read-backtest-results)):

```json
"netProfit": 155,
"totalTrades": 3,
"percentProfitable": 66.67,
"profitFactor": 4.1,
```

**"Gambar garis support di 102.80 pada chart saya."** Asisten menggambar garis horizontal dengan
`drawing_create`, dan `drawing_list` menampilkannya di samping gambar-gambar Anda sendiri, dengan
tanda bahwa garis itu digambar oleh sesi ini ([detail](../examples.md#9-draw-a-support-line)):

```json
"id": "DRW001",
"shape": "horizontal_line",
"text": "Support",
"createdByServer": true
```

**"Beri tahu saya kalau Apple menembus 110."** `alert_create` memasang alert harga di akun TradingView
Anda ([detail](../examples.md#10-create-a-price-alert)). Jika paket sudah memuat alert sebanyak
yang diizinkan, tool ini tidak membuat apa pun dan melaporkan batasnya, dan `alert_list` menampilkan
alert yang memenuhinya ([detail](../examples.md#11-create-an-alert-when-the-plan-is-full)):

```json
"symbol": "NASDAQ:AAPL",
"condition": "crossing",
"price": 110,
"expirationIso": "2024-11-26T00:00:00Z"
```

**"Tambahkan simbol-simbol ini ke watchlist saya: NYSE:IBM, FX:EURUSD, NASDAQ:MSFT, dan NASDAQ:MSTF."**
`watchlist_add_bulk` memeriksa setiap simbol dengan pencarian simbol TradingView, menambahkan yang
baru, dan menjelaskan mengapa yang lain dilewati ([detail](../examples.md#12-add-symbols-to-a-watchlist)):

```json
"added": ["NYSE:IBM", "FX:EURUSD"],
…
{ "symbol": "NASDAQ:MSFT", "reason": "already_listed" },
{ "symbol": "NASDAQ:MSTF", "reason": "unknown" }
```

**"Saya mau latihan dengan bar replay chart saya mulai 2024-06-03: maju lima bar, beri tahu posisi
kita sekarang, lalu akhiri replay-nya."** Asisten memulai bar replay dengan `replay_start`, melangkah
dengan `replay_step`, membaca posisi replay dengan `replay_status`, dan keluar dengan `replay_stop`.
Tidak ada transaksi sungguhan: tidak ada tool yang menempatkan order
([detail](../examples.md#13-practice-with-bar-replay)):

```json
"dateIso": "2024-06-07T00:00:00Z",
"stepped": 5,
…
"position": null,
"realizedPL": null
```

**"Ambil screenshot chart saya."** `screenshot_capture` menyerahkan gambar ke asisten sebagai image,
beserta ukurannya, dan tidak menulis apa pun ke disk
([detail](../examples.md#14-take-a-screenshot)):

```json
"data": { "target": "chart", "format": "jpeg", "width": 1180, "height": 640, "bytes": 3100 },
"meta": { "via": "cdp", "warnings": [] }
```

Server juga menyediakan lima prompt bawaan, yang ditampilkan oleh klien yang mendukung MCP prompts
agar bisa Anda pilih: `analyze_current_chart`, `multi_timeframe_review`, `write_and_backtest_strategy`,
`debug_pine_script`, dan `replay_practice_session`. Masing-masing memberi tahu asisten tool mana yang
harus dipanggil, dalam urutan apa, dan apa yang harus dilaporkan kembali. `replay_practice_session`
menjalankan sesi latihan di bar replay: asisten menelusuri masa lalu bar demi bar, menanyakan di
setiap langkah apakah Anda akan long, short, atau tetap flat, mencatat jurnal trade hipotetis ini pada
harga yang dibacanya dari chart, lalu menghitung untung atau ruginya. Asisten lebih dulu memeriksa
apakah ada replay milik Anda yang sedang berjalan, dan menanyakan apa yang harus dilakukan terhadapnya
sebelum mengubah apa pun; di akhir, asisten menghentikan replay yang dimulainya sendiri, dan tidak
pernah menghentikan replay milik Anda.

### <a id="safety"></a>Keamanan

Tool yang mengubah chart, skrip, atau akun Anda berhati-hati terhadap apa yang sudah menjadi milik
Anda. Mengganti teks yang belum disimpan di Pine Editor (selain editan belum tersimpan yang dibuat
sendiri oleh sesi server ini), menyimpan versi baru dari skrip yang tidak dibuat oleh sesi ini, dan
menghapus indikator yang sudah ada di chart Anda semuanya memerlukan `confirm: true`, yang seharusnya
hanya diberikan asisten setelah Anda setuju. Hal yang sama berlaku untuk menghapus gambar, alert,
simbol watchlist, atau tab yang tidak dibuat, ditambahkan, atau dibuka oleh sesi ini, menghapus semua
gambar di sebuah chart, berpindah dari layout yang memiliki perubahan belum tersimpan, dan beralih ke
layout multi-chart dengan jumlah chart lebih sedikit daripada yang ditampilkan tab, yang penyimpanan
berikutnya akan membuang chart lainnya. Batas paket, seperti jumlah indikator di sebuah chart, skrip
tersimpan, alert, atau chart dalam sebuah layout, diperiksa sebelum apa pun ditambahkan dan
dilaporkan sebagai error `PLAN_LIMIT` beserta batasnya; jika batas itu tidak bisa dibaca di build
TradingView Anda, tool tidak melakukan apa pun dan memberi tahu hal itu. Server tidak mengakali batas.
Tool lebih dulu memeriksa apa saja yang akan membuat TradingView membuka dialog upgrade-nya, atau
dialog lain miliknya, lalu menolak, tetapi masih ada beberapa prompt yang tidak bisa diantisipasi oleh
pemeriksaan ini: `layout_switch` bisa memunculkan prompt upgrade untuk layout multi-chart tersimpan
pada paket dengan jumlah chart lebih sedikit, untuk layout yang ditolak server TradingView karena
melebihi batas, dan untuk layout yang ditandai melebihi batas oleh daftar internal TradingView
sementara `layout_list` tidak menandainya; `layout_new` bisa memunculkan pesan TradingView saat
TradingView menolak layout baru setelah pemeriksaan; dan `tab_close` bisa memunculkan dialog "Close
tab?" untuk halaman yang butuh waktu lebih lama daripada batas tunggu TradingView untuk menyatakan
apakah layout-nya punya perubahan belum tersimpan, atau yang melaporkan rekaman sedang berlangsung.
Tool tingkat rendah `ui_*` mengklik dan mengetik apa yang Anda minta, jadi tool tersebut memang bisa
membuka dialog TradingView. Server tidak menghapus maupun mengganti nama skrip apa pun.

Tidak ada tool yang menempatkan order: bar replay hanya untuk latihan, dan asisten menyimpan trade
latihan apa pun di dalam percakapan. Screenshot dikirim ke klien sebagai image, dan server tidak
menulis satu pun ke disk. `ui_evaluate`, yang menjalankan JavaScript di halaman chart, nonaktif
kecuali Anda menjalankan server dengan `--allow-eval` (`TV_MCP_ALLOW_EVAL=true`).

### <a id="tool-profiles"></a>Profil tool

Secara bawaan, server menyediakan seluruh 83 tool-nya (`--profile full`). Beberapa klien hanya
menerima jumlah tool yang terbatas (Cursor memberi peringatan di atas 40). Untuk klien tersebut,
`--profile core` menyediakan set ringkas berisi 40 tool esensial, dan `--profile readonly` hanya
menyediakan 37 tool yang membaca. `--tools` menerima pola nama seperti `chart_*,data_*` dan
mempersempit profil lebih jauh: sebuah tool harus ada di profil dan cocok dengan salah satu pola, jadi
`--profile core --tools 'pine_*'` tetap tidak menyertakan `pine_open` dan `pine_save`, yang bukan tool
core; dengan profil bawaan, `--tools` saja sudah menentukan tool-nya. Beberapa deskripsi dan petunjuk
menyebut tool yang tidak disertakan `core`, seperti `pine_open` dan `pine_save`, yang tidak bisa
dipanggil asisten di bawah `core`. Resource mengikuti tool: masing-masing hanya disediakan bersama
tool yang berbagi data dengannya, seperti `tradingview://pine/source` dengan `pine_get_source`, jadi
`--tools 'chart_*'` menyediakan state chart dan tidak ada apa pun dari Pine Editor.

[Referensi tool](../tools.md) mencantumkan setiap tool beserta input-nya dan profil tempat tool itu
berada.

## <a id="troubleshooting"></a>Pemecahan masalah

[docs/troubleshooting.md](../troubleshooting.md) menjelaskan setiap kode error dan apa yang harus
dilakukan saat TradingView tidak ditemukan, port debug sedang dipakai, klien tidak menampilkan tool,
atau tunnel menolak request. `npx -y tradingview-desktop-mcp doctor` adalah hal pertama yang perlu
dijalankan.

## <a id="dashboard"></a>Dashboard

Server ini dilengkapi dashboard web untuk memantau apa yang dilakukan asisten Anda dan untuk mencoba
tool secara manual. Tidak perlu instalasi tambahan: paket yang dipublikasikan sudah membawanya, dan
`pnpm build` mem-build-nya ke dalam server pada checkout.

![Halaman status: TradingView dapat dijangkau dengan chart ditemukan dan aplikasi siap, informasi server, dan batas paket](../images/dashboard-status.png)

### <a id="open-it"></a>Membukanya

- **Transport HTTP:** jalankan server dengan token dan buka `http://127.0.0.1:8787/`. Dashboard
  aktif secara bawaan dalam mode ini; `--no-dashboard` (`TV_MCP_DASHBOARD=false`) menonaktifkannya.

  ```sh
  TV_MCP_AUTH_TOKEN="$(openssl rand -hex 32)" npx -y tradingview-desktop-mcp --transport http
  ```

  Dari checkout, jalankan `node packages/server/dist/cli.js --transport http` sebagai gantinya.

- **Berdampingan dengan stdio:** klien MCP yang menjalankan server lewat stdio juga bisa memiliki
  dashboard. Tambahkan `--dashboard` (`TV_MCP_DASHBOARD=true`) dan `TV_MCP_AUTH_TOKEN` ke
  konfigurasinya. Dashboard mendengarkan di alamatnya sendiri, `127.0.0.1:8787` kecuali Anda
  mengatur `--host` dan `--port`, dan tidak menyajikan `/mcp`. Tanpa token, atau jika port sudah
  terpakai, dashboard tetap nonaktif dan server mencatat peringatan di log, tetapi server MCP tetap
  berjalan. Panggilan yang dilakukan klien akan muncul di log langsung.

Server mencetak alamat dashboard di stderr saat dijalankan. Server tidak pernah mencetak token.

### <a id="the-token"></a>Token

Halaman meminta token (`TV_MCP_AUTH_TOKEN`) sebelum menampilkan apa pun. Tempelkan token, atau buka
`http://127.0.0.1:8787/#token=<token>` sekali: halaman membaca token dari fragment lalu menghapusnya
dari alamat, dan fragment tidak pernah dikirim ke server. Halaman menyimpan token di
`sessionStorage`, jadi token hilang saat Anda menutup tab, dan halaman hanya mengirim token sebagai
`Authorization: Bearer <token>`, tidak pernah di dalam URL. Saat server di-restart dengan token lain,
halaman akan meminta lagi. Lihat [SECURITY.md](../../SECURITY.md#the-dashboard).

### <a id="what-it-shows"></a>Yang ditampilkan

![Log langsung: tabel panggilan tool, terbaru di atas, dengan waktu, tool, asal, status, dan durasinya, serta pencarian dan filter di atasnya](../images/dashboard-log.png)

- **Status** menampilkan apakah TradingView dapat dijangkau (dan cara menjalankannya jika tidak),
  bagaimana server berjalan, batas paket, dan panggilan terbaru.
- **Log** menayangkan secara streaming setiap panggilan tool yang dijalankan server, baik yang dibuat
  oleh klien MCP maupun oleh dashboard, dengan filter berdasarkan nama tool, jeda, hapus, dan detail
  setiap panggilan. Setelah koneksi terputus, log menampilkan "Reconnecting…" dan melanjutkan dari
  tempat terakhir berhenti. Setiap tab dashboard yang terbuka menjaga satu event stream ke server, dan
  browser hanya mengizinkan sekitar enam koneksi ke satu host, jadi jika banyak tab dashboard terbuka,
  tab baru bisa harus menunggu koneksi yang kosong: tutup tab yang tidak Anda gunakan.
- **Tools** mencantumkan tool yang disediakan server, beserta input-nya, dan menjalankan salah satunya
  secara manual. Hasilnya ditampilkan apa adanya, dengan JSON panjang diciutkan di balik "Show all"
  dan gambar ditampilkan sebagai gambar.

![Halaman tools: daftar tool dengan pencarian dan filternya di kiri, dan chart_get_state dengan deskripsi, informasi, serta kolom input-nya di kanan](../images/dashboard-tools.png)

Menjalankan tool dari dashboard adalah panggilan tool sungguhan. Panggilan itu melewati registry yang
sama dengan panggilan MCP, jadi schema, profil, aturan `confirm`, dan pemeriksaan batas paket yang
sama tetap berlaku, dan panggilan itu muncul di log. Dashboard meminta konfirmasi Anda sebelum
menjalankan tool apa pun yang bukan read-only.

### <a id="the-api"></a>API

Halaman berkomunikasi dengan server melalui API kecil, yang juga bisa Anda panggil dengan `curl` dan
token. Setiap route memerlukan `Authorization: Bearer <token>`, dan server memeriksa `Host` dan
`Origin` seperti yang dilakukannya untuk `/mcp`.

| Route                    | Fungsinya                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `GET /api/info`          | Versi, transport, profil, jumlah tool, dan waktu mulai                                      |
| `GET /api/health`        | Laporan health: apakah TradingView dapat dijangkau                                          |
| `GET /api/tools`         | Tool yang tersedia, beserta schema dan anotasinya                                           |
| `POST /api/tools/<name>` | Menjalankan tool dengan `{"arguments": {...}}`, dengan asal `dashboard`                     |
| `GET /api/events`        | Server-sent events dari panggilan tool; `?limit=` mengatur berapa banyak yang diputar ulang |

File halaman itu sendiri, di `/`, tidak memerlukan token dan tidak memuat data.

## <a id="contributing"></a>Kontribusi

Lihat [CONTRIBUTING.md](../../CONTRIBUTING.md) untuk penyiapan lokal, tingkatan pengujian, konvensi commit,
dan cara membuat rilis, serta [docs/testing.md](../testing.md) untuk panduan pengujian. Untuk
melaporkan kerentanan, ikuti [SECURITY.md](../../SECURITY.md).

## <a id="disclaimer"></a>Penafian

Proyek ini tidak berafiliasi dengan, didukung oleh, atau disponsori oleh TradingView, Inc. TradingView
adalah merek dagang milik pemiliknya. Tidak ada isi di sini yang merupakan nasihat keuangan. Tool ini
mengubah apa yang ditampilkan aplikasi dan dapat menjangkau kontrolnya, jadi Anda bertanggung jawab
atas apa yang Anda otomatiskan dan atas kepatuhan terhadap ketentuan penggunaan TradingView.

## <a id="license"></a>Lisensi

Dirilis di bawah [lisensi MIT](../../LICENSE).
