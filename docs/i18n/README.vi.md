# tradingview-desktop-mcp

[English](../../README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Türkçe](README.tr.md) · [Русский](README.ru.md) · **Tiếng Việt** · [ไทย](README.th.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Українська](README.uk.md) · [Polski](README.pl.md) · [Português (Brasil)](README.pt-BR.md) · [العربية](README.ar.md) · [فارسی](README.fa.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Ελληνικά](README.el.md) · [മലയാളം](README.ml.md) · [Roman Urdu](README.ur-Latn.md) · [Română](README.ro.md)

[![npm](https://img.shields.io/npm/v/tradingview-desktop-mcp)](https://www.npmjs.com/package/tradingview-desktop-mcp)
[![CI](https://github.com/Mochamad-Rizky/tradingview-desktop-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Mochamad-Rizky/tradingview-desktop-mcp/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/Mochamad-Rizky/tradingview-desktop-mcp/graph/badge.svg)](https://codecov.io/gh/Mochamad-Rizky/tradingview-desktop-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../../LICENSE)

> Đây là bản dịch của [README tiếng Anh](../../README.md). Nếu hai bản có chỗ khác nhau, bản tiếng Anh là bản chuẩn để tham chiếu.

<p align="center">
  <a href="../media/promo.mp4"><img src="../media/teaser.gif" width="49%" alt="Video tổng quan: trợ lý đọc biểu đồ, vẽ đường hỗ trợ, viết Pine Script và đặt cảnh báo giá"></a>
  <a href="../media/tutorial.mp4"><img src="../media/tutorial-poster.jpg" width="49%" alt="Hướng dẫn cài đặt: thiết lập trong năm bước"></a>
</p>

<p align="center">
  <a href="../media/promo.mp4"><b>▶ Xem video tổng quan</b></a> (0:48) &nbsp;·&nbsp;
  <a href="../media/tutorial.mp4"><b>▶ Xem hướng dẫn cài đặt</b></a> (1:53)<br>
  <sub>Cả hai video đều dùng một biểu đồ dựng sẵn, không phải dữ liệu thị trường.</sub>
</p>

Một máy chủ [MCP](https://modelcontextprotocol.io) cho phép trợ lý AI đọc và điều khiển ứng dụng
TradingView Desktop trên chính máy của bạn. Nó điều khiển ứng dụng mà bạn đã đăng nhập sẵn qua Chrome
DevTools Protocol, thông qua cổng debug mà ứng dụng mở ra khi được khởi động với
`--remote-debugging-port`. Nó chỉ tự động hóa ứng dụng cục bộ: nó không đăng nhập thay bạn, không lách
giới hạn của gói tài khoản và không gọi đến máy chủ của TradingView.

> **Trạng thái: trước 1.0.** Tên công cụ và tùy chọn có thể thay đổi trước bản 1.0. Hãy cài gói từ npm
> như bên dưới, hoặc chạy máy chủ [từ mã nguồn](#quick-start-from-source). Dự án đã được thử trên macOS;
> Windows và Linux được hỗ trợ ở mức cố gắng hết sức.

Máy chủ cung cấp các công cụ ứng dụng (khởi chạy, kiểm tra tình trạng, phát hiện, trạng thái giao diện,
giới hạn gói, kết nối lại), công cụ biểu đồ (trạng thái, mã, khung thời gian, loại biểu đồ, vùng hiển
thị, cuộn), công cụ dữ liệu thị trường (nến, báo giá, thông tin và tìm kiếm mã), công cụ chỉ báo (liệt
kê, tìm kiếm, thêm, xóa, tham số đầu vào, hiển thị, giá trị), công cụ Pine Script (trình soạn thảo và
các script đã lưu, biên dịch, biên dịch thông minh với các bản sửa dựa trên quy tắc, phân tích ngoại
tuyến, console, cùng các đường, nhãn, hộp và bảng mà script vẽ ra), công cụ Strategy Tester (kết quả,
giao dịch, đường vốn), công cụ vẽ, cảnh báo và danh sách theo dõi, công cụ bố cục, đa biểu đồ và tab, bar
replay, ảnh chụp màn hình, công cụ giao diện cấp thấp (nhấp, di chuột, gõ, phím, cuộn, tìm, bảng, toàn
màn hình, và JavaScript trong trang biểu đồ khi bạn cho phép) và `batch_run`, công cụ chạy nhiều công cụ
trong một lần gọi. Máy chủ cũng cung cấp các tài nguyên (tình trạng ứng dụng, trạng thái và nến của biểu
đồ, mã nguồn Pine và kết quả biên dịch gần nhất, báo cáo chiến lược, danh sách theo dõi đang hoạt động),
mỗi tài nguyên đi kèm công cụ mà nó dùng chung dữ liệu, cùng năm prompt cho các công việc thường gặp. Một
dashboard web hiển thị các lệnh gọi theo thời gian thực và cho phép chạy công cụ thủ công (xem
[Dashboard](#dashboard)).

Mục lục: [Cài đặt bằng cách nhờ ứng dụng AI](#install-by-asking-your-ai-app), [Cài đặt](#install),
[Kết nối ứng dụng AI](#connect-your-ai-app), [Client từ xa và tunnel](#remote-clients-and-tunnels),
[Bắt đầu nhanh từ mã nguồn](#quick-start-from-source), [Sử dụng](#use-it),
[Khắc phục sự cố](#troubleshooting), [Dashboard](#dashboard), [Đóng góp](#contributing).

## <a id="install-by-asking-your-ai-app"></a>Cài đặt bằng cách nhờ ứng dụng AI

Bạn không cần tự gõ lệnh nào cả. Nếu ứng dụng AI của bạn có thể chạy lệnh trên máy tính, như Claude
Code, Cursor, VS Code, Windsurf, Gemini CLI và Codex CLI, thì nó có thể thiết lập giúp bạn. Trước tiên:

1. Cài [TradingView Desktop](https://www.tradingview.com/desktop/) và đăng nhập.
2. Cài [Node.js](https://nodejs.org) (bản LTS), nếu bạn chưa có.

Sau đó sao chép prompt này, dán vào ứng dụng AI và gửi đi:

```text
Hãy cài đặt máy chủ TradingView MCP giúp tôi. Đó là gói npm tradingview-desktop-mcp
(https://github.com/Mochamad-Rizky/tradingview-desktop-mcp). Hãy làm theo các bước sau và giải thích
từng bước cho tôi bằng lời đơn giản:

1. Kiểm tra xem Node.js 20.19 trở lên đã được cài chưa. Nếu chưa, hãy dừng lại và cho tôi biết cách cài.
2. Chạy "npx -y tradingview-desktop-mcp config <client>", với <client> là ứng dụng mà bạn đang chạy
   trong đó (claude-code, cursor, vscode, windsurf, gemini-cli hoặc codex-cli). Làm theo những gì lệnh
   in ra để thêm máy chủ vào cấu hình của tôi, và giữ nguyên các máy chủ khác đã có sẵn.
3. Khởi động TradingView bằng "npx -y tradingview-desktop-mcp launch". Nếu nó báo TradingView đang
   chạy mà không có cổng debug, hãy hỏi tôi trước, và chỉ khi tôi đồng ý mới chạy lại với --restart,
   vì lệnh đó sẽ đóng TradingView và tôi có thể mất các thay đổi chưa lưu.
4. Chạy "npx -y tradingview-desktop-mcp doctor" và cho tôi biết tất cả các bước kiểm tra có đạt không.
   Nếu bước kiểm tra biểu đồ thất bại, hãy bảo tôi đưa tab biểu đồ lên phía trước trong TradingView.
5. Cho tôi biết tôi có cần khởi động lại bạn, hoặc mở cuộc trò chuyện mới, trước khi các công cụ
   TradingView xuất hiện hay không.
```

Khi xong, hãy khởi động lại ứng dụng hoặc mở cuộc trò chuyện mới nếu nó bảo bạn làm vậy, rồi hỏi "Kiểm
tra xem TradingView đã được kết nối chưa." Sau đó hãy thử [các prompt bên dưới](#try-these-prompts).

Bạn dùng Claude Desktop? Ứng dụng này không chạy được lệnh, nhưng Claude Code, Cursor và các ứng dụng
khác ở trên có thể thiết lập giúp bạn: thêm "Hãy thiết lập cho Claude Desktop (config claude-desktop),
không phải cho ứng dụng này." vào cuối prompt. ChatGPT và OpenAI API cần một tunnel, mà bạn phải tự
thiết lập (xem
[Client từ xa và tunnel](#remote-clients-and-tunnels)). Nếu trợ lý gặp khó khăn, hãy tự làm theo các
bước bên dưới.

## <a id="install"></a>Cài đặt

Bạn cần:

- TradingView Desktop, đã cài và đăng nhập.
- Node.js 20.19 trở lên, đi kèm `npx`.

Không cần cài thêm gì khác: các client bên dưới khởi động máy chủ bằng `npx -y tradingview-desktop-mcp`,
lệnh này tải gói về ở lần dùng đầu tiên. Hãy khởi động TradingView cùng cổng debug. Lệnh `launch` sẽ
tìm ứng dụng và khởi động nó theo cách đó:

```sh
npx -y tradingview-desktop-mcp launch
```

TradingView chỉ cho phép chạy một phiên bản. Nếu nó đang chạy mà không có cổng debug, `launch` sẽ dừng
và báo cho bạn biết; `launch --restart` sẽ thoát ứng dụng một cách nhẹ nhàng rồi khởi động lại cùng
cổng, và TradingView có thể hỏi bạn lưu thay đổi trước. Hãy kiểm tra xem máy chủ có kết nối được với ứng
dụng không:

```sh
npx -y tradingview-desktop-mcp doctor
```

`doctor` sẽ không đạt bước kiểm tra biểu đồ khi tab biểu đồ đang ở nền, nằm sau trang New tab hoặc một
tab khác không có biểu đồ, vì vậy hãy đưa tab biểu đồ lên phía trước.
`npx -y tradingview-desktop-mcp --help` liệt kê các tùy chọn, và [.env.example](../../.env.example) liệt kê
các biến môi trường.

## <a id="connect-your-ai-app"></a>Kết nối ứng dụng AI

`config <client>` in ra đoạn cấu hình của một client và cho biết cần đặt nó ở đâu. Mỗi hướng dẫn bên
dưới chứa cùng đoạn cấu hình đó, các bước cho ứng dụng tương ứng và cách xử lý khi nó không hoạt động.

| Client                                         | In đoạn cấu hình                                       |
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

Phương thức truyền mặc định là stdio, trong đó stdout chỉ mang các thông điệp MCP còn log được ghi ra
stderr. Bảy client đầu tiên tự khởi động máy chủ. Trên Windows, client nào không khởi động trực tiếp
được `npx` sẽ cần dạng `cmd /c npx`, và `config` in ra dạng này khi chạy trên Windows (hoặc với
`--platform win32`). `--profile` chuyển một [hồ sơ công cụ](#tool-profiles) tới máy chủ.

### <a id="remote-clients-and-tunnels"></a>Client từ xa và tunnel

ChatGPT và OpenAI API không thể khởi động chương trình trên máy tính của bạn. Chúng truy cập máy chủ qua
một địa chỉ HTTPS công khai, vì vậy bạn chạy máy chủ qua HTTP và đặt một tunnel phía trước. Như vậy là
đưa lên internet một máy chủ có thể điều khiển TradingView đang đăng nhập của bạn: hãy dùng
`--profile readonly`, một token mạnh (`TV_MCP_AUTH_TOKEN`), host công khai của tunnel trong
`--allowed-hosts` (`TV_MCP_ALLOWED_HOSTS`), và `--no-dashboard`, để các tệp của dashboard không bị phục
vụ qua tunnel. Các hướng dẫn cho [ChatGPT](../clients/chatgpt.md) và
[OpenAI API](../clients/openai-api.md) trình bày từng bước, và
[SECURITY.md](../../SECURITY.md#tunnels-and-remote-clients) liệt kê những gì một token chỉ đọc vẫn có thể
truy cập.

## <a id="quick-start-from-source"></a>Bắt đầu nhanh từ mã nguồn

Để chạy bản checkout thay cho gói đã phát hành, bạn cần Node.js 24 để build máy chủ (`nvm use` đọc
`.nvmrc`) và [pnpm](https://pnpm.io), với phiên bản được cố định trong `package.json`. Máy chủ sau khi
build chạy được trên Node.js 20.19 trở lên.

```sh
git clone https://github.com/Mochamad-Rizky/tradingview-desktop-mcp.git
cd tradingview-desktop-mcp
pnpm install && pnpm build
node packages/server/dist/cli.js launch
node packages/server/dist/cli.js doctor
```

`node packages/server/dist/cli.js config <client> --local` in ra đoạn cấu hình của một client cho bản
checkout này, dùng `node` và đường dẫn tuyệt đối của `cli.js` thay cho `npx`. Với client dùng cấu hình
JSON, mục cấu hình trông như sau:

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

Ngoài ra còn có phương thức truyền HTTP (`--transport http`); hãy đọc [SECURITY.md](../../SECURITY.md) trước
khi dùng.

## <a id="use-it"></a>Sử dụng

Kết nối một client MCP như mô tả ở trên, với TradingView đang chạy cùng cổng debug, rồi yêu cầu điều bạn
muốn bằng lời thông thường. Trợ lý sẽ tự chọn và gọi công cụ, nên bạn không cần biết tên của chúng.
[Tài liệu tham khảo công cụ](../tools.md) liệt kê mọi công cụ cùng tham số đầu vào và các hồ sơ mà
công cụ đó thuộc về.

### <a id="try-these-prompts"></a>Hãy thử các prompt này

Mỗi prompt bên dưới là một trong các ví dụ trong [docs/examples.md](../examples.md), tài liệu cho thấy
các lệnh gọi công cụ mà trợ lý thực hiện và kết quả, trong đó các danh sách dài hơn ba mục bị cắt bớt,
thời gian của mỗi lệnh gọi (`durationMs`) bị lược bỏ và ảnh chụp màn hình được nêu tên trong một ghi chú
thay vì hiển thị. Các đoạn trích là những dòng trong các kết quả đó, và `…` đánh dấu chỗ lược bỏ các dòng
thuộc phần khác của kết quả. Các giá trị là dữ liệu tổng hợp: chúng đến từ một ứng dụng TradingView giả
với biểu đồ NASDAQ:AAPL dựng sẵn, nên không có gì là dữ liệu thị trường và không có gì đến từ tài khoản
nào; kết quả có đúng cấu trúc mà máy chủ trả về, dù báo cáo Strategy Tester đứng sau ví dụ backtest vẫn
chưa được đọc từ ứng dụng thật.

**"Biểu đồ của tôi đang hiển thị gì vậy? Cho tôi biết mã, khung thời gian và những chỉ báo nào đang có
trên đó."** Trợ lý đọc biểu đồ bằng `chart_get_state`
([chi tiết](../examples.md#1-read-the-chart)):

```json
"symbol": "NASDAQ:AAPL",
"resolution": "1D",
"chartTypeName": "candles",
```

**"Cho tôi xem 3 cây nến ngày gần nhất."** Trợ lý đọc dữ liệu nến bằng `data_get_ohlcv`
([chi tiết](../examples.md#3-read-the-last-candles)):

```json
"timeIso": "2024-10-27T00:00:00Z",
"open": 103.58,
"close": 103.42,
```

**"Thêm MACD vào biểu đồ của tôi."** Trên một biểu đồ đã có số chỉ báo tối đa mà gói cho phép,
`indicator_add` không thêm gì và báo giới hạn, còn việc xóa một chỉ báo của bạn để lấy chỗ cần bạn xác
nhận ([chi tiết](../examples.md#5-add-an-indicator-to-a-full-chart)):

```json
"code": "PLAN_LIMIT",
"message": "The chart holds as many indicators as the plan allows (2)",
```

**"Viết một chỉ báo Pine Script vẽ đường trung bình động 9 nến và 21 nến của giá đóng cửa, và kiểm tra
xem nó có biên dịch được không."** Trợ lý đưa script vào Pine Editor bằng `pine_new` và biên dịch bằng
`pine_compile` ([chi tiết](../examples.md#6-write-and-compile-a-pine-script)):

```json
"success": true,
"errors": [],
"warnings": [],
```

**"Script trong Pine Editor của tôi không biên dịch được. Bạn sửa giúp được không?"**
`pine_smart_compile` biên dịch script, áp dụng các bản sửa dựa trên quy tắc cho những lỗi mà nó biết,
chẳng hạn tên của Pine v4 trong script v6, rồi biên dịch lại, mà không thay đổi trình soạn thảo
([chi tiết](../examples.md#7-fix-a-pine-script-with-smart-compile)):

```json
"message": "Could not find function or function reference 'study'",
…
"applied": ["Replace study( with indicator(", "Replace rsi( with ta.rsi("]
…
"writtenBack": false
```

**"Chiến lược trên biểu đồ của tôi có kết quả backtest thế nào?"** Trợ lý đọc Strategy Tester bằng
`strategy_get_results` và `strategy_get_trades`
([chi tiết](../examples.md#8-read-backtest-results)):

```json
"netProfit": 155,
"totalTrades": 3,
"percentProfitable": 66.67,
"profitFactor": 4.1,
```

**"Vẽ đường hỗ trợ tại 102.80 trên biểu đồ của tôi."** Trợ lý vẽ một đường ngang bằng `drawing_create`,
và `drawing_list` hiển thị nó bên cạnh các hình vẽ của chính bạn, được đánh dấu là do phiên này vẽ
([chi tiết](../examples.md#9-draw-a-support-line)):

```json
"id": "DRW001",
"shape": "horizontal_line",
"text": "Support",
"createdByServer": true
```

**"Báo cho tôi khi Apple cắt qua mức 110."** `alert_create` đặt một cảnh báo giá trong tài khoản
TradingView của bạn ([chi tiết](../examples.md#10-create-a-price-alert)). Khi gói đã có số cảnh báo
tối đa cho phép, nó không tạo gì và báo giới hạn, còn `alert_list` hiển thị các cảnh báo đang chiếm chỗ
([chi tiết](../examples.md#11-create-an-alert-when-the-plan-is-full)):

```json
"symbol": "NASDAQ:AAPL",
"condition": "crossing",
"price": 110,
"expirationIso": "2024-11-26T00:00:00Z"
```

**"Thêm các mã này vào danh sách theo dõi của tôi: NYSE:IBM, FX:EURUSD, NASDAQ:MSFT và NASDAQ:MSTF."**
`watchlist_add_bulk` kiểm tra từng mã bằng chức năng tìm kiếm mã của TradingView, thêm các mã mới và
cho biết lý do bỏ qua các mã còn lại ([chi tiết](../examples.md#12-add-symbols-to-a-watchlist)):

```json
"added": ["NYSE:IBM", "FX:EURUSD"],
…
{ "symbol": "NASDAQ:MSFT", "reason": "already_listed" },
{ "symbol": "NASDAQ:MSTF", "reason": "unknown" }
```

**"Cho tôi luyện tập bằng bar replay trên biểu đồ của tôi từ ngày 2024-06-03: tiến năm nến, cho tôi
biết đang ở đâu, rồi kết thúc replay."** Trợ lý bắt đầu bar replay bằng `replay_start`, tiến từng bước
bằng `replay_step`, đọc vị trí hiện tại của replay bằng `replay_status` và thoát bằng `replay_stop`.
Không có giao dịch nào: không công cụ nào đặt lệnh
([chi tiết](../examples.md#13-practice-with-bar-replay)):

```json
"dateIso": "2024-06-07T00:00:00Z",
"stepped": 5,
…
"position": null,
"realizedPL": null
```

**"Chụp ảnh màn hình biểu đồ của tôi."** `screenshot_capture` chuyển ảnh cho trợ lý dưới dạng hình
ảnh, kèm kích thước, và không ghi gì xuống đĩa
([chi tiết](../examples.md#14-take-a-screenshot)):

```json
"data": { "target": "chart", "format": "jpeg", "width": 1180, "height": 640, "bytes": 3100 },
"meta": { "via": "cdp", "warnings": [] }
```

Máy chủ cũng cung cấp năm prompt riêng, mà client hỗ trợ MCP prompt sẽ liệt kê để bạn chọn:
`analyze_current_chart`, `multi_timeframe_review`, `write_and_backtest_strategy`, `debug_pine_script`
và `replay_practice_session`. Mỗi prompt cho trợ lý biết cần gọi những công cụ nào, theo thứ tự nào và
cần báo cáo lại những gì. `replay_practice_session` chạy một buổi luyện tập trên bar replay: trợ lý đi
qua quá khứ từng nến một, ở mỗi bước hỏi bạn sẽ mua (long), bán khống (short) hay đứng ngoài, ghi nhật
ký các giao dịch giả định này với mức giá đọc từ biểu đồ, và tính lãi hoặc lỗ của chúng. Trước tiên nó
kiểm tra xem có replay nào của bạn đang chạy không, và hỏi bạn muốn xử lý thế nào trước khi thay đổi bất
cứ điều gì; khi kết thúc, nó dừng replay mà nó đã bắt đầu, và không bao giờ dừng replay của bạn.

### <a id="safety"></a>An toàn

Các công cụ thay đổi biểu đồ, script hoặc tài khoản của bạn đều cẩn trọng với những gì vốn đã là của
bạn. Thay thế văn bản chưa lưu trong Pine Editor (trừ chỉnh sửa chưa lưu do chính phiên máy chủ này tạo
ra ở đó), lưu phiên bản mới của một script mà phiên này không tạo, và xóa một chỉ báo vốn đã có trên biểu
đồ của bạn đều cần `confirm: true`, và trợ lý chỉ nên truyền giá trị này sau khi bạn đồng ý. Điều tương
tự áp dụng cho việc xóa một hình vẽ, cảnh báo, mã trong danh sách theo dõi hoặc tab mà phiên này không
tạo, thêm hoặc mở, xóa mọi hình vẽ của một biểu đồ, chuyển khỏi một bố cục có thay đổi chưa lưu, và
chuyển sang bố cục đa biểu đồ có ít biểu đồ hơn số tab đang hiển thị, vì lần lưu tiếp theo sẽ làm mất các
biểu đồ còn lại. Giới hạn của gói, như số chỉ báo trên một biểu đồ, số script đã lưu, số cảnh báo hay số
biểu đồ của một bố cục, được kiểm tra trước khi thêm bất cứ thứ gì và được báo dưới dạng lỗi
`PLAN_LIMIT` kèm giá trị giới hạn; khi không đọc được giới hạn trên bản build TradingView của bạn, công
cụ sẽ không làm gì và báo cho bạn biết. Máy chủ không lách giới hạn. Các công cụ kiểm tra trước những gì
sẽ khiến TradingView mở hộp thoại nâng cấp, hoặc một hộp thoại khác của chính nó, và từ chối thay vì thực
hiện, nhưng vẫn còn một vài lời nhắc mà các bước kiểm tra này không lường trước được: `layout_switch` có
thể gặp lời nhắc nâng cấp với một bố cục đa biểu đồ đã lưu trên gói có ít biểu đồ hơn, với một bố cục mà
máy chủ TradingView từ chối vì vượt giới hạn, và với một bố cục mà danh sách TradingView tự lưu cho mình
đánh dấu là vượt giới hạn trong khi `layout_list` thì không; `layout_new` có thể gặp thông báo của
TradingView khi nó từ chối bố cục mới sau các bước kiểm tra; và `tab_close` có thể gặp hộp thoại
"Close tab?" với một trang mất nhiều thời gian hơn mức TradingView chờ để cho biết bố cục của nó có thay
đổi chưa lưu hay không, hoặc với một trang báo đang ghi hình. Các công cụ `ui_*` cấp thấp nhấp và gõ đúng
những gì bạn yêu cầu, nên theo thiết kế chúng có thể mở hộp thoại của TradingView. Máy chủ không xóa và
không đổi tên script nào.

Không công cụ nào đặt lệnh: bar replay dùng để luyện tập, và trợ lý chỉ giữ các giao dịch luyện tập trong
cuộc trò chuyện. Ảnh chụp màn hình được gửi đến client dưới dạng hình ảnh, và máy chủ không ghi ảnh nào
xuống đĩa. `ui_evaluate`, công cụ chạy JavaScript trong trang biểu đồ, bị tắt trừ khi bạn khởi động máy
chủ với `--allow-eval` (`TV_MCP_ALLOW_EVAL=true`).

### <a id="tool-profiles"></a>Hồ sơ công cụ

Theo mặc định, máy chủ cung cấp toàn bộ 83 công cụ (`--profile full`). Một số client chỉ chấp nhận một số
lượng công cụ giới hạn (Cursor cảnh báo khi vượt quá 40). Với các client đó, `--profile core` cung cấp
một bộ rút gọn gồm 40 công cụ thiết yếu, còn `--profile readonly` chỉ cung cấp 37 công cụ chỉ đọc.
`--tools` nhận các mẫu tên như `chart_*,data_*` và thu hẹp hồ sơ thêm nữa: một công cụ phải nằm trong
hồ sơ và khớp với một mẫu, nên `--profile core --tools 'pine_*'` vẫn loại bỏ `pine_open` và
`pine_save`, vốn không phải công cụ core; với hồ sơ mặc định, chỉ riêng `--tools` sẽ quyết định các công
cụ. Một số mô tả và gợi ý có nhắc tới những công cụ mà `core` loại bỏ, như `pine_open` và `pine_save`,
mà trợ lý không thể gọi khi dùng `core`. Tài nguyên đi theo công cụ: mỗi tài nguyên chỉ được cung cấp
cùng với công cụ mà nó dùng chung dữ liệu, chẳng hạn `tradingview://pine/source` đi cùng
`pine_get_source`, nên `--tools 'chart_*'` cung cấp trạng thái biểu đồ và không có gì của Pine Editor.

[Tài liệu tham khảo công cụ](../tools.md) liệt kê mọi công cụ cùng tham số đầu vào và các hồ sơ mà
công cụ đó thuộc về.

## <a id="troubleshooting"></a>Khắc phục sự cố

[docs/troubleshooting.md](../troubleshooting.md) giải thích từng mã lỗi và cách xử lý khi không tìm
thấy TradingView, cổng debug đang bị chiếm, client không hiển thị công cụ hoặc tunnel từ chối một yêu
cầu. Việc đầu tiên nên chạy là `npx -y tradingview-desktop-mcp doctor`.

## <a id="dashboard"></a>Dashboard

Máy chủ đi kèm một dashboard web để theo dõi những gì trợ lý của bạn làm và để thử chạy công cụ thủ công.
Không cần cài thêm gì: gói đã phát hành có sẵn dashboard, và `pnpm build` build nó vào máy chủ của bản
checkout.

![Trang trạng thái: TradingView truy cập được, đã tìm thấy biểu đồ và ứng dụng sẵn sàng, thông tin về máy chủ, và các giới hạn của gói](../images/dashboard-status.png)

### <a id="open-it"></a>Mở dashboard

- **Phương thức truyền HTTP:** khởi động máy chủ với một token và mở `http://127.0.0.1:8787/`. Ở chế
  độ này dashboard bật theo mặc định; `--no-dashboard` (`TV_MCP_DASHBOARD=false`) sẽ tắt nó.

  ```sh
  TV_MCP_AUTH_TOKEN="$(openssl rand -hex 32)" npx -y tradingview-desktop-mcp --transport http
  ```

  Từ bản checkout, hãy chạy `node packages/server/dist/cli.js --transport http` thay thế.

- **Song song với stdio:** một client MCP khởi động máy chủ qua stdio cũng có thể có dashboard. Thêm
  `--dashboard` (`TV_MCP_DASHBOARD=true`) và `TV_MCP_AUTH_TOKEN` vào cấu hình của client đó. Dashboard
  lắng nghe trên địa chỉ riêng, là `127.0.0.1:8787` trừ khi bạn đặt `--host` và `--port`, và không
  phục vụ `/mcp`. Nếu không có token, hoặc khi cổng đã bị chiếm, dashboard sẽ tắt và máy chủ ghi một
  cảnh báo vào log, nhưng máy chủ MCP vẫn tiếp tục chạy. Các lệnh gọi mà client thực hiện sẽ hiện trong
  log trực tiếp.

Máy chủ in địa chỉ của dashboard ra stderr khi khởi động. Nó không bao giờ in token.

### <a id="the-token"></a>Token

Trang yêu cầu token (`TV_MCP_AUTH_TOKEN`) trước khi hiển thị bất cứ thứ gì. Hãy dán token vào, hoặc mở
`http://127.0.0.1:8787/#token=<token>` một lần: trang đọc token từ fragment và xóa nó khỏi địa chỉ, và
fragment không bao giờ được gửi đến máy chủ. Trang giữ token trong `sessionStorage`, nên token sẽ mất khi
bạn đóng tab, và trang chỉ gửi token dưới dạng `Authorization: Bearer <token>`, không bao giờ đặt trong
URL. Khi máy chủ khởi động lại với một token khác, trang sẽ hỏi lại. Xem
[SECURITY.md](../../SECURITY.md#the-dashboard).

### <a id="what-it-shows"></a>Những gì dashboard hiển thị

![Log trực tiếp: bảng các lệnh gọi công cụ, mới nhất ở trên cùng, với thời gian, công cụ, nguồn gọi, trạng thái và thời lượng, cùng ô tìm kiếm và bộ lọc phía trên](../images/dashboard-log.png)

- **Status** cho biết TradingView có truy cập được không (và cách khởi động nó nếu không), máy chủ
  đang chạy thế nào, các giới hạn của gói và các lệnh gọi gần nhất.
- **Log** truyền trực tiếp mọi lệnh gọi công cụ mà máy chủ chạy, dù do client MCP hay dashboard thực
  hiện, kèm bộ lọc theo tên công cụ, tạm dừng, xóa và chi tiết của từng lệnh gọi. Sau khi mất kết nối,
  nó hiển thị "Reconnecting…" và tiếp tục từ chỗ đã dừng. Mỗi tab dashboard đang mở giữ một luồng sự
  kiện tới máy chủ, và trình duyệt chỉ cho phép khoảng sáu kết nối tới một host, nên khi mở nhiều tab
  dashboard, tab mới có thể phải chờ một kết nối trống: hãy đóng các tab bạn không dùng.
- **Tools** liệt kê các công cụ mà máy chủ cung cấp, cùng tham số đầu vào, và cho phép chạy thủ công
  một công cụ. Kết quả được hiển thị đúng như khi trả về, với JSON dài được thu gọn sau "Show all" và
  hình ảnh hiển thị dưới dạng hình ảnh.

![Trang công cụ: danh sách công cụ cùng ô tìm kiếm và bộ lọc ở bên trái, và chart_get_state cùng mô tả, thông tin và các trường nhập liệu ở bên phải](../images/dashboard-tools.png)

Một lần chạy từ dashboard là một lệnh gọi công cụ thật. Nó đi qua cùng registry với một lệnh gọi MCP,
nên cùng schema, hồ sơ, quy tắc `confirm` và các bước kiểm tra giới hạn gói đều được áp dụng, và nó
xuất hiện trong log. Dashboard yêu cầu bạn xác nhận trước khi chạy bất kỳ công cụ nào không phải chỉ đọc.

### <a id="the-api"></a>API

Trang giao tiếp với máy chủ qua một API nhỏ, mà bạn cũng có thể gọi bằng `curl` và token. Mọi route đều
cần `Authorization: Bearer <token>`, và máy chủ kiểm tra `Host` và `Origin` giống như với `/mcp`.

| Route                    | Chức năng                                                                        |
| ------------------------ | -------------------------------------------------------------------------------- |
| `GET /api/info`          | Phiên bản, phương thức truyền, hồ sơ, số công cụ và thời điểm khởi động          |
| `GET /api/health`        | Báo cáo tình trạng: TradingView có truy cập được không                           |
| `GET /api/tools`         | Các công cụ đang được cung cấp, cùng schema và annotation của chúng              |
| `POST /api/tools/<name>` | Chạy một công cụ với `{"arguments": {...}}`, với nguồn gọi là `dashboard`        |
| `GET /api/events`        | Server-sent events của các lệnh gọi công cụ; `?limit=` đặt số lượng cần phát lại |

Các tệp của chính trang, tại `/`, không cần token và không chứa dữ liệu.

## <a id="contributing"></a>Đóng góp

Xem [CONTRIBUTING.md](../../CONTRIBUTING.md) để biết cách thiết lập môi trường cục bộ, các cấp độ kiểm thử,
quy ước commit và cách phát hành một bản release, và [docs/testing.md](../testing.md) để xem hướng
dẫn kiểm thử. Để báo cáo lỗ hổng bảo mật, hãy làm theo [SECURITY.md](../../SECURITY.md).

## <a id="disclaimer"></a>Tuyên bố miễn trừ trách nhiệm

Dự án này không liên kết với, không được chứng thực hay tài trợ bởi TradingView, Inc. TradingView là
nhãn hiệu của chủ sở hữu. Không có nội dung nào ở đây là lời khuyên tài chính. Các công cụ thay đổi
những gì ứng dụng hiển thị và có thể chạm tới các điều khiển của nó, vì vậy bạn chịu trách nhiệm về những
gì bạn tự động hóa và về việc tuân thủ điều khoản sử dụng của TradingView.

## <a id="license"></a>Giấy phép

Phát hành theo [giấy phép MIT](../../LICENSE).
