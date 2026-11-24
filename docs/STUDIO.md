# LumaSprite Studio — hướng dẫn sử dụng

LumaSprite Studio giữ lệnh `pxl`, định dạng dự án và engine gốc để tương thích.
Skill dùng chung: [pxl-art](../skills/pxl-art/SKILL.md). Cài bằng
`node scripts/install-pixel-skill.js --install`; bỏ `--install` để chỉ xem vị trí.
Installer giữ nguyên skill có nội dung khác, không tự ghi đè.

AI trong app mặc định dùng hướng dẫn `baseline`. Để thử skill cho server riêng trên PowerShell:
`$env:PXL_ART_GUIDANCE='skill-v1'`, sau đó chạy Studio trên cổng/workspace thử nghiệm.
Giá trị này không đổi model, tài khoản hoặc quyền CLI; restart với `baseline` để quay lại.
Hai client agent có thể cần mở phiên mới để thấy skill vừa cài.

Giới hạn AI đã được điều chỉnh theo lựa chọn ngày25/10/2026: tối đa300giây/phương án,
900giây cho đợt3phương án. Lượt sửa JSON/mã nằm trong cùng ngân sách. Nút Hủy vẫn hoạt động;
chỉ xác nhận đã dừng sau khi tiến trình cục bộ kết thúc. Retry do người dùng bấm có ngân sách
300giây riêng và dùng lại ngữ cảnh/guidance đã chụp. Skill không được bật mặc định trước khi
người dùng duyệt báo cáo; chọn A/B không tự coi là đồng ý đổi mặc định.

Studio chạy trên localhost và lưu dự án ngay trên máy. Không cần hosting hoặc API key
để dùng phần chỉnh sửa. AI sử dụng CLI và phiên đăng nhập của từng CLI khi bạn bấm Tạo đề xuất.

## Pixel Editor mới: vẽ trực tiếp

Trang `/` hiện là editor pixel v2. Dự án mã/overlay v1 được mở tại **Mã & dự án cũ**
(`/legacy.html`); hướng dẫn chế độ mã ở các mục sau vẫn áp dụng. Không tự chuyển đổi dự án v1.

1. Bấm **+ Dự án pixel**, chọn 16, **18**, 24, 32, 48, **64**, 128 hoặc 256 px,
   hoặc nhập chiều rộng/cao độc lập. Mặc định 32×32 trong suốt; có khóa tỉ lệ và màu nền.
2. Bảng **Asset** gom nhóm theo phân loại: **Nhân vật**, **Đồ vật** và **Tileset** (Maps sẽ được kích hoạt ở M3).
   Asset chưa phân loại được hiển thị dưới mục Đồ vật mà không gây lưu ngầm khi chỉ mở dự án.
   Các phiên bản của cùng một asset logic được gom nhóm hiển thị cùng nhau, có huy hiệu phiên bản (`v1`, `v2`...).
   Mỗi phiên bản giữ đầy đủ hàng riêng để chọn vẽ, checkbox để chọn xuất PNG/ZIP nhiều asset, và nút xóa riêng.
3. Thao tác xóa asset và hoàn tác (Ctrl+Z): xóa asset sẽ dọn sạch chỉ mục thư viện và các tham chiếu phong cách
   trong cùng một thao tác hoàn tác; Undo khôi phục đầy đủ cả pixel, frame cels, chỉ mục thư viện và tham chiếu.
   Khi xóa frame trên timeline, các tham chiếu đã lưu đến frame bị xóa cũng được dọn sạch trong cùng bước Undo
   để không cản trở việc xóa frame.
4. Vẽ lên layer đang chọn. Dùng bảng layer × frame ở dưới để chọn cel, ẩn/hiện, khóa,
   sắp xếp hoặc thêm layer/frame. Nhóm có visibility, lock và opacity áp dụng cho con.
5. Dữ liệu tự lưu sau 500 ms ngừng chỉnh sửa; **Lưu** tạo thêm mốc phục hồi.
6. Bấm PNG, GIF, Strip + JSON, Atlas + JSON hoặc ZIP. Chọn checkbox cạnh asset để xuất nhiều.
   **Xem atlas** giữ đúng ZIP của revision đã xem để tải lại mà không dựng sang bản mới.

**Canvas…** thêm/cắt vùng làm việc theo một trong 9 neo. **Co giãn ảnh…** đổi kích thước
nội dung bằng nearest-neighbor. Cả hai áp dụng cho mọi layer/frame và undo được, có preview
phần bị cắt. Pivot được giữ vị trí theo pixel khi đổi canvas và giới hạn về mép nếu nằm ngoài;
hitbox dịch theo neo hoặc co giãn theo ảnh. Event đi theo frame khi thêm/xóa/sắp xếp.

Bút/tẩy có cỡ 1–64 px, đầu vuông/tròn, đối xứng X/Y và pixel-perfect cho bút 1 px.
Đường/chữ nhật/ellipse có Shift khóa hướng/tỉ lệ, tùy chọn hình đặc. Fill và đũa thần có
tolerance 0–255, contiguous và lấy mẫu layer hiện tại/ảnh tổng hợp.

Vùng chọn chữ nhật/đũa thần dùng Shift để thêm, Alt để bớt khi đang dùng công cụ chọn.
Copy/paste, di chuyển, lật, xoay 90° tạo **vùng nổi**: Enter hoặc nút Áp dụng để chốt,
Esc để hủy. Paste hiện dùng clipboard pixel nội bộ của app. Khóa layer bảo vệ pixel
của cả cel liên kết. Nhập PNG bằng nút hoặc kéo thả vào canvas; sprite sheet cho chọn
kích thước ô, lề ngoài, khoảng cách và thứ tự theo hàng/cột. Ô không đủ kích thước không được nhập.

### Phím tắt và điều hướng

Mặc định gần Aseprite: P bút, E tẩy, G fill, I lấy màu, M chọn, W đũa thần, L đường,
U chữ nhật, O ellipse, V di chuyển và H kéo canvas. Giữ Alt lấy màu tạm, Space kéo canvas;
thả phím hoặc mất focus sẽ trở về công cụ trước. Trong công cụ chọn, Alt được dùng để bớt vùng.

- X đổi màu trước/sau; `[` / `]` đổi cỡ bút; Ctrl+Z hoàn tác; Ctrl+Shift+Z/Ctrl+Y làm lại.
- Ctrl+A/D chọn hết/bỏ chọn. Ctrl+X/C/V thao tác pixel khi ở canvas, thao tác cel khi timeline có focus.
- Shift+N thêm layer; Shift+F thêm frame; Enter phát/dừng hoặc xác nhận vùng nổi.
- Ctrl+S lưu; `/` tìm lệnh. Ctrl/Alt + con lăn zoom quanh con trỏ; H hoặc Space + kéo để pan.
- **Phím tắt** cho đổi phím, phát hiện trùng/tổ hợp Chrome giữ, chọn preset Studio hiện tại
  (B bút), nhập/xuất JSON. Cấu hình nằm trên máy trong trình duyệt. Không bắt phím khi nhập
  văn bản/IME hoặc trong CodeMirror. Dùng menu/nút cho Ctrl+N/W/T và các phím Chrome giữ.

### Animation

Nhân bản thường tạo dữ liệu cel độc lập; **Nhân bản liên kết** dùng cùng nội dung cel.
Sửa cel liên kết tác động mọi vị trí liên kết; **Tách liên kết** để chỉnh riêng.
Ctrl chọn nhiều cel/frame, Shift chọn khoảng. Kéo thả đổi thứ tự frame/layer hoặc di chuyển cel;
Ctrl+kéo cel để copy. Ctrl+C/V trên timeline cũng copy/paste vùng cel.
Duration (ms) áp dụng cho frame hoặc nhóm frame đang chọn. Frame mới mặc định 100 ms.

Tag có khoảng frame, forward/reverse/ping-pong và loop/one-shot. Chọn tag trước khi phát
hoặc xuất GIF/strip. Onion-skin có frame trước/sau, màu và opacity riêng, không xuất vào ảnh.
PNG/atlas giữ RGBA. GIF có giới hạn định dạng: tối đa 256 màu, không có bán trong suốt,
timing theo 10 ms và encoder hiện đặt tối thiểu 20 ms; JSON/strip giữ timing gốc.

### Dữ liệu, phục hồi và mã/AI

Project v2 có `pxl.project.json`, blob RGBA nén theo checksum tại `.pxl/cels/` và tối đa
20 manifest phục hồi tại `.pxl/pixel-history/`. Blob được ghi trước manifest; cel/frame/layer
dùng ID ổn định. Blob dùng số màu 0xRRGGBBAA, lưu byte little-endian trong zlib.
Undo theo thao tác, tối đa 100 thao tác hoặc 64 MiB; ảnh hiện tại được giữ khi lịch sử cũ bị rút gọn.
Giới hạn: mỗi chiều 4096 px, 600 frame, 256 layer và 32 triệu pixel cel mỗi asset.

Mở dự án tải metadata trước, tải cel/thumbnail theo nhu cầu. Cache pixel không chỉnh sửa
được thu hồi trên ngưỡng 64 MiB, ngoại trừ cel frame đang vẽ. Bản nháp lưu trong IndexedDB.
Hai tab hoặc file sửa ngoài app gây xung đột revision: **Lưu bản sao** giữ bản nháp,
**Tải lại** giữ một bản sao trước khi mở bản trên đĩa. Cel sai checksum bị từ chối khi đọc/lưu.
**Lịch sử** có thể phục hồi bản còn nguyên khi blob mới nhất bị hỏng. Không tự sửa file hỏng.

Sao lưu ZIP có cả lịch sử và blob. Giải nén rồi **Mở sao lưu**, chọn thư mục vừa giải nén;
app kiểm tra checksum, tạo dự án mới và giữ các mốc phục hồi. Nguồn gốc được giữ nguyên.
Tài nguyên mở rộng (`studio.resources`) như mặt nạ và mảng điểm ảnh tham chiếu được lưu nén
theo hash SHA256 tại `.pxl/resources/<sha256>.(rgba|mask|tile-index).z`. Manifest dự án chỉ lưu
metadata (loại, kích thước, blob digest) mà không chứa inline buffer. Bộ đệm đã giải mã được tải
lười theo yêu cầu (`GET /api/pixel/projects/:id/resource?revision=N&resource=ID`), chia sẻ hạn mức thu
hồi bộ nhớ 64 MiB (chỉ giải phóng bộ đệm đã lưu không thay đổi, bảo vệ dữ liệu chưa lưu và đang tải),
và được tự động nạp lại khi hoàn tác/làm lại (Undo/Redo). Sao lưu và mở thư mục sao lưu hỗ trợ đầy đủ
tài nguyên cùng với cel và lịch sử.

**Từ dự án mã** dựng asset v1 rồi tạo dự án pixel mới với ảnh cuối cùng đã raster hóa,
bao gồm overlay. Không khôi phục lại cấu trúc layer thủ tục từ mã. Trang chính tập trung vẽ;
các công cụ viết mã vẫn ở **Mã & dự án cũ**.

### Tạo ảnh bằng AI

1. Bấm **Trợ lý AI** để mở không gian tạo ảnh. Chọn Codex hoặc DeepSeek API, nhập mô tả,
   chọn phong cách, góc nhìn và palette. Kích thước lấy từ asset đang chọn.
2. Có thể chỉnh hướng sáng, mức chi tiết, đường bao và chọn tối đa 3 asset/frame tham chiếu.
   **Lưu phong cách dự án** lưu các thiết lập này; chỉ mở panel không sửa dự án.
   Palette dự án đã lưu và palette của asset hiện tại là hai lựa chọn riêng.
3. Bấm **Tạo 3 phương án**. App gọi CLI tuần tự, hiển thị số lần gọi/sửa lỗi và thời gian thật.
   Giới hạn 300 giây mỗi phương án, 900 giây mỗi đợt. Không có lượt AI chấm thẩm mỹ.
4. Chọn thẻ phương án để xem ảnh, frame và cảnh báo. **Chuẩn hóa palette** thêm biến thể
   xử lý trên máy, không gọi AI thêm. Có thể chọn lại ảnh gốc để so sánh.
5. Khi đợt tạo xong, chọn phương án hợp lệ. Ở chi tiết đề xuất:
   - Chọn **Tạo asset mới**: nhập tên (1–100 ký tự) và chọn phân loại (**Nhân vật**, **Đồ vật**, hoặc **Tileset**; mặc định Đồ vật).
   - Chọn **Tạo phiên bản mới của asset có sẵn**: chọn asset gốc từ danh sách trong dự án. Nếu asset gốc đã được lập chỉ mục,
     phân loại tự động khóa theo nhóm của asset gốc; nếu asset gốc chưa phân loại, lựa chọn phân loại sẽ áp dụng cho cả
     asset gốc (v1) và phiên bản mới (v2).
   - Thumbnail phương án được phóng to theo tỉ lệ nguyên (integer nearest-neighbor) trong khung 64px để xem rõ chi tiết.
   - Bấm **Áp dụng**. Trong lúc áp dụng, toàn bộ nút thao tác và phím Escape được khóa chặt chẽ để đảm bảo an toàn dữ liệu.
   - Nét vẽ cũ được giữ nguyên. Đóng panel bằng **Quay lại vẽ pixel**. Đề xuất chưa áp dụng được khôi phục khi tải lại
     trang trong cùng phiên máy chủ; máy chủ khởi động lại sẽ dọn kho đề xuất tạm.

Phương án lỗi có nút **Thử lại** riêng. **Hủy đợt tạo** dừng cả phương án đang chạy và các
phương án đang chờ. Nếu chưa xác nhận được tiến trình đã dừng, app giữ trạng thái chưa rõ.
Đề xuất revision cũ phải tạo lại. App không tự đổi CLI, tài khoản hoặc quyền toàn máy.
**Tạo animation từ frame hiện tại** dùng cùng luồng ba phương án và giữ phần cấu hình vùng
khóa, số frame, timing và loop.

**Chỉnh sửa vùng đã chọn** (`#ai-region-edit`):
1. **Chọn vùng:** Dùng công cụ chọn chữ nhật (phím M) hoặc đũa thần (phím W) trên canvas để chọn vùng pixel cần sửa.
   Nếu chưa chọn vùng, hộp thoại hiển thị hướng dẫn rõ ràng và nút tạo đề xuất bị vô hiệu hóa; app không tự ý thay
   thế bằng toàn canvas hoặc bounding box hình chữ nhật.
2. **Xem trước và kiểm tra:** Hộp thoại hiển thị thông tin frame nguồn (tên asset, số frame, kích thước, thời lượng ms),
   số lượng pixel được chọn, ảnh tổng hợp kèm lớp phủ màu xanh thể hiện chính xác từng pixel được phép thay đổi, cùng điểm neo.
   Các pixel nằm ngoài vùng chọn được bảo vệ tuyệt đối theo RGBA gốc.
3. **Mô tả chỉnh sửa:** Nhập yêu cầu chỉnh sửa (1–12.000 ký tự), lưu bản nháp riêng biệt với prompt vẽ mới và prompt animation.
   Hệ thống có khóa đồng bộ chống gửi trùng và ngăn phím Esc/hủy khi đang khởi tạo đợt tạo.
4. **Đối chiếu và chọn biến thể:** Đợt tạo sinh 3 phương án. Trong bảng chi tiết, biến thể khóa vùng (protected) được
   chọn mặc định và sẵn sàng áp dụng. Biến thể AI gốc (raw) chỉ để xem và bị khóa nút áp dụng. Có thể bật các lớp phủ
   kiểm tra khác biệt (difference) và vùng sửa (movement), hoặc bấm **Chuẩn hóa palette** để tạo bản xem trước cục bộ
   mà không gọi CLI thêm.
5. **Áp dụng:** Áp dụng phương án đã chọn thành asset mới hoặc phiên bản mới của asset hiện tại. Vùng ngoài giữ nguyên
   100% pixel RGBA của frame nguồn; thời lượng frame, pivot phân số, hitbox và event được bảo toàn nguyên vẹn.
6. **Xử lý lệch palette:** Nếu frame nguồn chứa màu ngoài palette đích đã chọn, hệ thống từ chối ngay với mã lỗi 422
   và không tốn lượt gọi CLI nào. Người dùng có thể bấm **Chuẩn hóa mẫu thành bản sao** để duyệt trước bản sao chuẩn
   hóa palette, sau đó chọn vùng trên bản sao mới để chỉnh sửa tiếp.

### Thư viện asset và phiên bản

Danh sách bên trái chia thành **Nhân vật**, **Đồ vật** và **Tileset**. Asset cũ chưa phân loại
hiện trong Đồ vật; chỉ mở dự án không tự thay đổi dữ liệu. Nhãn v1, v2… phân biệt từng bản
trong một nhóm. Bấm tên để vẽ, checkbox để chọn xuất, nút × để xóa đúng bản ở hàng đó.

Khi duyệt đề xuất AI hoặc bản chuẩn hóa, có thể nhập tên, chọn phân loại rồi chọn:

- **Asset mới:** tạo nhóm riêng, bắt đầu từ v1.
- **Phiên bản mới:** chọn asset gốc. App thêm một asset riêng, tăng số phiên bản và giữ nguyên
  pixel/layer/tên của bản gốc. Nhóm đã phân loại sẽ kế thừa loại đó. Với asset cũ chưa phân loại,
  lần đầu chọn loại sẽ gán cho cả bản gốc v1 và bản mới v2.

Các phiên bản đều có thể chọn, vẽ và xuất độc lập. Xóa v1 không xóa các bản sau. Ctrl+Z/Ctrl+Y
khôi phục/làm lại thao tác xóa cùng dữ liệu thư viện và các tham chiếu ảnh; xóa frame cũng dọn
tham chiếu tới frame đó trong cùng thao tác Undo. Nguồn AI và cấu hình tạo ảnh được lưu kèm
asset như thông tin lịch sử; các gợi ý bộ phận/điểm mốc của AI chưa phải dữ liệu nhân vật đã duyệt.

### Hồ sơ và bộ phận nhân vật (M2b)

Bấm **Nhân vật** trên thanh điều hướng hoặc gõ `/` rồi tìm lệnh **Nhân vật** để mở trình quản lý hồ sơ nhân vật:

1. **Tạo hồ sơ:** Bấm **+ Tạo mới** để tạo hồ sơ từ asset và frame đang chọn. Hồ sơ mới ở trạng thái **Chưa duyệt**. Mở hay đóng editor khi chưa bấm tạo sẽ không làm thay đổi hay ghi ngầm cấu trúc extension vào tài liệu.
2. **Duyệt mẫu hiện tại:** Khi ảnh mẫu, palette và pivot đã đúng ý, bấm **Duyệt mẫu hiện tại** để chụp lại composite, bảng màu và điểm neo (pivot) làm mốc chuẩn. Trạng thái chuyển sang **Sẵn sàng**.
3. **Phát hiện dữ liệu cũ (Stale):** Khi pixel nguồn, palette, kích thước hoặc pivot của asset bị thay đổi, hệ thống cảnh báo trạng thái **Cần duyệt lại** kèm lý do cụ thể. Người dùng cần kiểm tra và bấm **Duyệt mẫu hiện tại** để cập nhật mốc chuẩn.
4. **Bộ phận & Mặt nạ vùng chọn:** Chọn vùng bất kỳ trên canvas chính (công cụ Chọn M hoặc Đũa thần W), sau đó bấm **+ Thêm từ vùng chọn** để lưu mặt nạ bộ phận chính xác theo từng pixel (không bị giới hạn bởi bounding box chữ nhật). Có thể cập nhật lại mặt nạ từ vùng chọn mới, đổi tên hoặc xóa bộ phận.
5. **Điểm mốc (Khớp nối) & Liên kết xương:** Thêm các điểm mốc với tọa độ số nguyên và có thể gán vào bộ phận. Chọn một điểm trong danh sách để sửa tên, X/Y và bộ phận, rồi bấm lưu thay đổi. Nút **Đặt vị trí trên canvas** cho phép nhấp một ô để đặt điểm đã chọn. Có thể kéo trực tiếp điểm trên ảnh; mỗi lần kéo là một bước Ctrl+Z. **Esc** hủy kéo hoặc chế độ đặt điểm. Tạo liên kết bằng cách chọn hai điểm khác nhau. Những lớp này chỉ dùng hướng dẫn, không ghi vào pixel hay PNG xuất ra.
6. **Lớp phủ xem trước:** Hỗ trợ bật/tắt lưới pixel, lớp phủ mặt nạ bộ phận màu cyan, khớp nối & xương liên kết, và điểm neo pivot màu vàng. Các lớp phủ này chỉ phục vụ hiển thị trên giao diện, hoàn toàn không bị nướng vào ảnh pixel gốc hay ảnh xuất PNG/ZIP.
7. **Gợi ý từ AI:** Nếu asset có sẵn dữ liệu gợi ý từ AI manifest (bộ phận hoặc điểm mốc), hệ thống hiển thị tùy chọn **Nhập gợi ý vào bản nháp**. Gợi ý AI luôn được nhập dưới dạng chưa duyệt để người dùng kiểm tra và quyết định trước khi duyệt.

Các mục sau mô tả chế độ mã v1 tại `/legacy.html`.

## Mở app

Từ thư mục gốc checkout:

```powershell
npm ci
npm run build
npm run studio
```

Mở http://127.0.0.1:4321/ hoặc bấm `start-studio.bat` sau khi build.
Launcher kiểm tra Node 22.18 trở lên và bản build, rồi mở URL loopback Studio in ra.
Chọn thư mục dự án hoặc cổng bằng `start-studio.bat --root DIR --port 4330`.
Dùng `Ctrl+C` ở terminal để dừng. Các lệnh `build`, `serve`, `list`, `ascii` vẫn hoạt động.

```powershell
node bin/pxl.js studio --root D:\PixelProjects --port 4322
```

Node chính thức của repo là >=22.18. Bản vá Node 22.15 đã có trong checkout vẫn được giữ;
Studio đã được kiểm tra trên Node 22.15 của máy này. Không có thao tác nâng Node tự động.
Khi chạy trong môi trường hạn chế, localhost/CLI có thể cần quyền truy cập của môi trường đó;
app báo lỗi thật và không tự thay đổi quyền.

## Tạo, mở và nhập dự án

- **Tạo mới:** chọn sprite, animation, scene hoặc canvas trống 32×32.
- **Nhập thư mục:** chọn thư mục có file `.px.js`/`.px.ts`, kèm các file `include` tương đối.
  App tạo bản sao mới; không sửa thư mục gốc. Với dự án Studio, lấy cả thư mục `.pxl` để giữ pixel/metadata.
- **Dự án:** chọn dự án để mở lại. Mặc định được lưu trong `projects/` cạnh nơi chạy lệnh;
  thư mục này đã được Git bỏ qua.
- **Sao lưu ZIP:** chứa nguồn, manifest, lớp pixel, metadata và các mốc phục hồi hiện có.
  Giải nén rồi Nhập thư mục để khôi phục dữ liệu hiện tại.

Mỗi dự án có `pxl.project.json`, file nguồn, `.pxl/pixels.json`, `.pxl/metadata.json`
và `.pxl/history/`. Không tự đổi tên/xóa các file này trong lúc app đang lưu.

## Viết mã, xem và vẽ pixel

Chọn **Mã nguồn**, **Vẽ & xem** hoặc **Mã + ảnh**. Editor có syntax highlighting và undo/redo.
Tự lưu sau 500 ms ngừng nhập; lỗi dựng hiển thị file/dòng khi engine cung cấp vị trí.
Ảnh thành công gần nhất vẫn được giữ khi mã mới bị lỗi, nhưng app chặn xuất ảnh từ mã lỗi.

Canvas có bút (B), tẩy (E), tô vùng (G), lấy màu (I), đường thẳng, khung chữ nhật,
chọn vùng, di chuyển vùng, sao chép/dán và lật ngang/dọc. Không có vùng chọn thì copy/flip dùng toàn ảnh.
Một nét kéo chuột là một thao tác undo. Các nút undo/redo giữ tối đa 100 thao tác trong phiên;
editor cũng hỗ trợ phím tắt riêng. **Vừa khung** chọn mức zoom nguyên phù hợp với không gian xem.

Mã nguồn và nét vẽ được lưu riêng. Lớp pixel được ghép sau khi dựng asset, trước khi asset được
đặt vào asset khác, nên sửa sprite cũng cập nhật scene dùng sprite đó.

- **Lớp pixel:** bật/tắt và lưu trạng thái vào dự án, tác động cả ảnh xuất.
- **Giữ để so mã:** tạm xem phần ảnh không có lớp chỉnh tay của asset hiện tại.
- **Frame/Phát:** xem/chỉnh từng frame, tôn trọng loop hoặc one-shot.
- **Onion-skin:** hiện frame trước mờ phía dưới, không xuất vào ảnh.
- **Các bước vẽ:** xem trace frame đầu; bấm lại để đóng trước khi tiếp tục vẽ.

Đổi kích thước, tên asset hoặc timing có thể làm lớp pixel không còn tương thích.
App giữ lớp cũ, báo xung đột và chặn xuất. Chọn asset đích rồi dùng **Chuyển sang asset hiện tại**:
giữ tọa độ trong phần giao nhau và frame còn tồn tại; pixel/frame nằm ngoài bị loại khỏi bản chuyển,
nhưng có thể undo. Hoặc **Loại lớp khỏi bản hiện tại** để tắt lớp cũ mà không xóa dữ liệu đó.

## Lưu và phục hồi

**Lưu phiên bản** tạo mốc của trạng thái vừa lưu. Lịch sử giữ 20 mốc gần nhất;
trước khi áp dụng AI hoặc phục hồi cũng có mốc để quay lại.

Revision bảo vệ khỏi hai tab hoặc trình sửa file bên ngoài cùng ghi. Nếu có xung đột,
app giữ bản nháp trong tab và localStorage. **Tải lại** cho phép lưu bản nháp thành dự án riêng
trước khi lấy bản từ đĩa. Khi mở lại tab có bản nháp, app cung cấp nút khôi phục.
Không dùng localStorage thay cho sao lưu ZIP; trình duyệt có thể xóa dữ liệu đó.

## AI với Codex và DeepSeek

1. Chọn provider rồi bấm **Kiểm tra kết nối**. Codex kiểm tra `login status`. DeepSeek
   đọc trạng thái cấu hình phía máy chủ; giao diện phân biệt trạng thái này với lần gọi đã thành công.
2. Nhập mô tả, bấm **Tạo đề xuất**. Codex có thể nhận ảnh preview và vùng tham chiếu.
   DeepSeek nhanh nhận yêu cầu văn bản thuần qua LiteRouter.
3. App dựng thử, cho xem ảnh trước/sau và mã đề xuất. **Áp dụng đề xuất** mới lưu vào dự án.
4. Có thể hủy tác vụ. Nếu app không xác nhận dừng được tiến trình, nó báo `unknown`, không nhận
   kết quả về muộn. Hủy HTTP dừng nhận dữ liệu tại Studio; trạng thái xử lý phía LiteRouter cần xác nhận riêng. Thông tin tác vụ còn trong phiên server,
   có thể mở lại dự án/tab để xem tác vụ đang chạy hoặc đề xuất còn chờ.

Mặc định: một tác vụ AI/dự án, tối đa một lượt sửa lỗi JSON/mã. Luồng tạo ảnh pixel
có `generationOptions` giới hạn tổng **300 giây** (cấu hình timeout ngắn hơn vẫn có hiệu lực).
API cũ không có cấu hình mới và viewer mã giữ ngân sách 600 giây tương thích,
có thể tùy chỉnh bằng biến môi trường `PXL_AI_TIMEOUT`.
Đề xuất trên revision cũ bị từ chối khi áp dụng. Lịch sử Antigravity vẫn đọc được.

App tìm Codex CLI trong PATH hoặc các vị trí cài đặt Codex trên Windows.
Có thể chỉ định executable cho phiên terminal trước khi chạy app.

```powershell
$env:PXL_CODEX_CLI = 'C:\duong-dan\codex.exe'
$env:PXL_AI_TIMEOUT = '600000' # API cũ; tạo ảnh pixel mới vẫn tối đa 300 giây
npm run studio
```

Đăng nhập Codex CLI trong terminal nếu Codex chưa sẵn sàng. Với DeepSeek, đặt khóa riêng của
Studio vào biến môi trường `PXL_DEEPSEEK_API_KEY` của tiến trình máy chủ. Hạn mức hoặc phí của
tài khoản áp dụng khi gửi yêu cầu thật.

Nếu LiteRouter trả HTTP 402, kiểm tra số dư và quyền dùng model của khóa Studio trên LiteRouter.
Nếu báo **DeepSeek API kết thúc nhưng không trả nội dung đề xuất**, gateway đã kết thúc
luồng mà không gửi nội dung để dựng, kể cả khi usage báo token đầu ra. App dừng lượt đó,
không tự gọi sửa JSON hoặc chuyển provider. Giữ lại thông báo số event/byte/usage để
chẩn đoán; không cần gửi khóa API. HTTP 200 không đủ để xác nhận đã tạo được asset.
Nút **Kiểm tra kết nối** của DeepSeek chỉ kiểm tra khóa đã được cấu hình ở máy chủ.

File nguồn là chương trình JavaScript; chỉ mở dự án đáng tin cậy. Worker/VM không được quảng cáo
là sandbox bảo mật để nhận mã tùy ý từ Internet. Studio chỉ phục vụ localhost, không dùng làm hosting công khai.

## Xuất ảnh và dữ liệu game

- **PNG gốc:** ảnh/frame hiện tại có RGBA, không có lưới/onion-skin.
- **GIF:** animation, hỗ trợ one-shot; giới hạn màu/độ chính xác thời gian của định dạng GIF vẫn áp dụng.
- **Strip + JSON:** ZIP ảnh frame và metadata animation.
- **Xem atlas / Atlas + JSON:** MaxRects, extrusion mặc định 1 px, tối đa 4096 px một cạnh.
  Tọa độ frame JSON chỉ tới phần ảnh gốc, không gồm extrusion.
- **ZIP asset đã chọn:** đánh dấu checkbox cạnh asset; không đánh dấu thì xuất toàn bộ asset công khai.
  Kèm `metadata/pxl.json`; không xuất part bắt đầu bằng `_` trừ khi chọn cụ thể.

App cũng giữ lần tải xuất gần nhất trong `exports/`. Manifest ghi hash file do app tạo;
chỉ dọn file cũ nếu vẫn đúng hash. File tự thêm hoặc đã sửa được giữ, tránh ghi đè bằng tên mới.
Preview không tự sinh hàng loạt ảnh ra `out/`; lệnh `serve` cũ vẫn giữ cách xuất `out/` như trước.

Trong **Thuộc tính game**, metadata của asset dùng định dạng:

```json
{
  "pivot": { "x": 0.5, "y": 1 },
  "hitbox": { "x": 2, "y": 3, "w": 12, "h": 14 },
  "events": [{ "frame": 2, "name": "footstep" }]
}
```

Pivot chuẩn hóa 0–1; hitbox tính theo pixel; frame của event bắt đầu từ 0.
JSON atlas/animation giữ các trường cũ và thêm `meta.pxl` (schemaVersion 1) cho metadata/loop.
Chưa có importer engine riêng, physics hoặc runtime gameplay.

Animation xuất được chuẩn hóa theo canvas gốc để tránh nhảy vị trí do crop. Không âm thầm cắt timeline:
vượt 600 frame hoặc chu kỳ ghép 60 giây sẽ báo lỗi. Studio có ngân sách 32 triệu pixel tổng cho
mỗi animation, timeout dựng 30 giây, 2 worker preview/build, cache tối đa 128 MB/64 mục;
cache frame phía trình duyệt giữ tối đa 32 mục. Mã đổi làm vô hiệu hóa toàn bộ cache dự án.

## Màu và bố cục vùng vẽ pixel

Asset mới có sẵn palette 32 màu. Với asset cũ hoặc ảnh PNG nhập vào, dùng
**+ Bảng màu mặc định** để bổ sung màu mẫu; các màu riêng đang có được giữ lại.
Thao tác thay palette có thể hoàn tác.

Trong thanh bên, mở **Hiển thị vùng vẽ** để đổi màu nền vùng làm việc, chọn
caro trong suốt xám/sáng/tối và chỉnh độ rộng thanh bên từ 280 đến 520 px
(mặc định 360 px). Các tùy chọn lưu trên máy; ảnh PNG xuất giữ nguyên RGBA.
Ở cửa sổ hẹp, thanh bên tự giới hạn để chừa chỗ cho canvas.

Rê chuột vào đường phân cách giữa canvas và timeline rồi kéo lên/xuống để đổi chiều
cao hai vùng. Đường phân cách trước thanh thuộc tính bên phải kéo trái/phải để đổi
độ rộng. Kích thước được lưu trên máy; nhấp đúp đường phân cách để về mặc định.
Cũng có thể Tab đến đường phân cách và dùng phím mũi tên (Shift để đổi nhanh).

Danh sách **Asset** bên trái có nút **+** để thêm và **×** cạnh từng tên để xóa đúng
asset đó. Ctrl+Z khôi phục, Ctrl+Shift+Z/Ctrl+Y làm lại trong lịch sử undo hiện tại.
Xóa asset cuối cùng tạo canvas trống cùng kích thước/palette; dự án vẫn mở để vẽ tiếp.

## Tạo ảnh AI theo phong cách và palette

Trong **Mã & trợ lý AI**, chọn phong cách **Game rõ nét** (mặc định), **8-bit tối giản**
hoặc **Icon phẳng**; góc nhìn theo mô tả/chính diện/ngang/từ trên xuống. Palette mặc định
lấy từ asset hiện tại; có thể chọn AI tự chọn tối đa 16 màu. Kích thước luôn theo canvas.

**Tham chiếu asset hiện tại** mặc định tắt: AI chỉ nhận nguồn khởi tạo trống, không nhận
ảnh hay mã asset trước. Bật tùy chọn này để gửi frame đầu tiên và mã nguồn nếu có.
Có thể yêu cầu sửa ảnh, nhưng chưa sửa trực tiếp layer/vùng chọn hoặc bảo đảm giữ
chính xác từng pixel của ảnh vẽ tay. Kết quả chỉ được **Áp dụng thành asset mới**.

Mỗi yêu cầu trả một phương án; app không gọi AI thêm để đánh giá vẻ đẹp hoặc tinh chỉnh.
Worker kiểm tra pixel thật và hiển thị kích thước/số màu/cảnh báo. Ảnh rỗng hoặc sai kích
thước bị chặn Áp dụng ở cả giao diện lẫn API. Màu ngoài palette, vượt số màu hoặc bán
trong suốt chỉ cảnh báo để bạn quyết định. Preview có 1×/2×/4×/8× không làm mượt.
Sprite phụ tên bắt đầu `_` được giữ trong nguồn nhưng không nhập thành asset riêng.

API `POST /api/pixel/projects/:id/ai` nhận trường tùy chọn:

```json
{
  "generationOptions": {
    "style": "game",
    "view": "description",
    "paletteMode": "asset",
    "reference": false
  }
}
```

Giá trị tương ứng: `game|eight-bit|flat-icon`, `description|front|side|top-down`,
`asset|auto16`, boolean. Máy chủ chụp kích thước/palette/asset/revision vào `job.generation`;
không nhận palette do client tự cung cấp. Preview trả thêm `generation` và `quality`
(thống kê từng asset, `errors`, `warnings`); job sau preview cũng chứa `quality`.
Áp dụng ảnh lỗi trả HTTP 422; revision cũ trả 409. Bỏ `generationOptions` giữ luồng cũ.

### Mẫu prompt có sẵn

Mở **Mã & trợ lý AI → Mẫu prompt** để chọn trong 11 mẫu: nhân vật nhỏ, nhân vật chi
tiết, nhân vật nhìn từ trên xuống, quái, bình thuốc, vũ khí/dụng cụ, rương, cây,
idle 4 frame, hiệu ứng va chạm 6 frame và đổi màu ảnh tham chiếu.

Sửa **Chủ thể / thay đổi mong muốn**, đọc prompt xem trước rồi bấm **Dùng mẫu**.
Nút này thay nội dung mô tả và đặt phong cách, góc nhìn, tham chiếu gợi ý; giữ nguyên
canvas và lựa chọn palette. **Hoàn tác chèn mẫu** khôi phục nội dung/cấu hình trước đó.
Chọn hoặc chèn mẫu không gọi AI; chỉ **Tạo đề xuất** mới gửi yêu cầu tới CLI.

Mẫu tự dùng kích thước canvas hiện tại. Kích thước gợi ý chỉ giúp chọn mức chi tiết,
không tự resize. Nếu đổi canvas sau khi đã chèn, xem và dùng mẫu lại để cập nhật mô tả.
Mẫu đổi màu bật tham chiếu frame 1 và cần palette có màu đích; vẫn phải kiểm tra ảnh
đề xuất vì AI chưa bảo đảm giữ nguyên từng pixel. Mẫu giúp mô tả rõ hơn, không bảo đảm
mọi kết quả đều đẹp hoặc đúng ý ngay lần đầu.

### Chuẩn hóa palette và animation từ mẫu chuẩn

Trong **Mã & trợ lý AI**, tạo đề xuất như trước. Ở khung xem trước, bấm **Chuẩn hóa
palette** để tạo thêm biến thể cục bộ; AI gốc vẫn giữ nguyên. Đổi ngưỡng alpha 1–255
(mặc định 128), chọn biến thể và xem số màu/pixel đổi, lớp khác biệt trước khi **Áp dụng
thành asset mới**. Palette tự chọn dùng chung tối đa 16 màu cho toàn bộ animation;
palette asset dùng các màu đục đang có. Không tạo thêm dithering.

Để làm chuyển động từ nét vẽ hiện tại:

1. Chọn asset và frame mẫu. Dùng công cụ **M** chọn vùng chứa cả vị trí cũ/mới của
   bộ phận cần chuyển động, ví dụ mắt hoặc đuôi.
2. Mở **Tạo animation từ frame hiện tại**. Kiểm tra vùng xanh, điểm neo, mô tả,
   2–24 frame, thời lượng và chế độ lặp. Nếu muốn làm đi/chạy toàn thân, chọn
   **Toàn nhân vật**; chế độ này không bảo đảm giữ nguyên thiết kế.
3. Nếu mẫu có màu/alpha chưa khớp, dùng **Chuẩn hóa mẫu thành bản sao**, xem rồi áp
   dụng bản sao; chọn lại vùng trên bản sao và tạo animation. Không sửa mẫu gốc.
4. Xem AI gốc, bản đã khóa vùng và bản chuẩn hóa. Có phát/dừng, chọn frame,
   onion-skin, điểm neo và overlay khác biệt/vùng sửa/pixel đơn/mẫu xen kẽ 2×2.
5. Chọn biến thể rồi áp dụng. Ở chế độ khóa vùng, ảnh AI gốc chỉ xem; chỉ bản đã
   ghép mẫu được áp dụng. Máy chủ kiểm tra lại từng pixel ngoài mask.

Chuẩn hóa, ghép vùng và chẩn đoán chạy trong worker, không phát sinh lượt AI.
Cảnh báo bounding box đổi trên 20%, đáy hình lệch trên 1 px hay pixel đơn không phải
kết luận ảnh lỗi hoặc xấu; người dùng vẫn cần duyệt chuyển động. Xuất ảnh dùng pixel
đã áp dụng; onion-skin, điểm neo và overlay chỉ để xem. Animation từ mẫu giữ loop/
one-shot đã chọn khi phát và xuất GIF/strip, kể cả chưa chọn tag thủ công.

Chi tiết API, giới hạn và nghiệm thu: [pixel-consistency.md](pixel-consistency.md).

## Animation với pose, keyframe và frame đóng băng

1. Ở **Nhân vật**, tạo hồ sơ từ đúng asset/frame, đặt điểm mốc và duyệt mẫu.
2. Mở **Animation nhân vật**, chọn hồ sơ rồi tạo clip 2–24 frame. Với **Khóa ngoài
   vùng chọn**, hãy chọn vùng trên frame nguồn trước; app hiển thị overlay và yêu
   cầu xác nhận. **Toàn nhân vật** cho phép AI thay đổi cả hình.
3. Chọn từng ô trên timeline. Kéo điểm pose hoặc nhập X/Y rồi lưu; một lần kéo là
   một thao tác undo. Esc hủy lần kéo. Có thể thêm, nhân bản, xóa và đổi chỗ frame,
   chỉnh timing, bật keyframe và onion-skin.
4. **Đóng băng pixel** giữ nguyên frame khi tạo lại. **Keyframe hướng dẫn** gửi pose
   cho AI, không bảo đảm giữ nguyên pixel. Chỉ những frame bật **Tạo lại bằng AI**
   và không đóng băng mới được gửi để tạo lại.
5. Chọn Codex, palette và mô tả chuyển động. Mặc định giữ palette nhân
   vật đã duyệt; tùy chọn ≤16 màu lấy một palette chung từ mẫu. Nếu mẫu không khớp
   màu/alpha, hãy duyệt bản sao chuẩn hóa trước, hoặc dùng palette nguồn đầy đủ.
6. Xem ba phương án. AI gốc chỉ chứa các frame được tạo lại; bản đã ghép chứa toàn
   bộ clip. Frame giữ nguyên không có ảnh AI gốc tương ứng nên app đối chiếu với
   baseline của đúng frame đó. Chọn biến thể rồi **Áp dụng thành asset mới** hoặc
   phiên bản mới, sau đó xuất PNG/GIF/strip/atlas như bình thường.

Pose là hướng dẫn chuyển động, không phải rig tự động. Điểm neo/đường tiếp đất,
onion-skin và overlay không xuất vào ảnh. Áp dụng AI giữ nguyên hồ sơ và bản nháp
clip; muốn dùng pixel từ frame đang vẽ làm baseline, chọn **Chụp frame đang vẽ vào
đây…** và xác nhận. Có thể mở lại clip bằng **Chỉnh clip và tạo lại…** từ workspace
AI. CLI thật dùng hạn mức tài khoản; kiểm thử tự động dùng CLI giả lập.

## Phát triển và kiểm tra

```powershell
npm run check
npm run build
npm run test:studio-ui
node scripts/check-examples.js
node scripts/check-package.js
npm pack --dry-run
```

UI test dùng Chrome đã cài, workspace tạm, Codex CLI giả lập và DeepSeek HTTP fixture.
`check-examples.js` dựng 13 ví dụ trong thư mục tạm rồi dọn.
Vite dev server (`npm run studio:dev`) proxy API về Studio trên cổng 4321; mở backend ở terminal khác.

Smoke test với provider thật dùng dự án tạm và có thể sử dụng hạn mức tài khoản.
Chạy lệnh tương ứng khi bạn muốn kiểm tra kết nối và luồng dựng/áp dụng.

```powershell
node scripts/smoke-studio-ai.js codex
node scripts/smoke-studio-ai.js deepseek
```

Lệnh DeepSeek cần `PXL_DEEPSEEK_API_KEY` của Studio trong môi trường terminal.
Phép thử yêu cầu đúng một pixel `#70c989ff` ở (16,16), còn lại trong suốt.
Sau khi áp dụng trong dự án tạm, worker dựng lại dữ liệu đã lưu và kiểm tra
toàn bộ 1024 pixel. Ngân sách provider của lệnh smoke là 240 giây, dành phần
thời gian còn lại cho dựng cục bộ và dọn dữ liệu. Kết quả ghi transport,
số lượt gọi, model và usage khi provider trả về.

So sánh ảnh thật trước/sau (8 yêu cầu CLI, dùng hạn mức tài khoản):

```powershell
node scripts/check-ai-quality.js codex --review
```

Ảnh ở thư mục tạm; sau khi xem, Enter hoặc tạo file `REVIEW_DONE` trong đúng thư mục
được in ra để dọn. Tự dọn sau 10 phút ở chế độ review. Bỏ `--review` để dọn ngay khi xong.
Có thể lọc bằng `--case=CHARACTER-18` hoặc `--case=CHARACTER-64 --arms=old`.
Kết quả đánh giá thực tế được ghi trong `docs/ai-generation-quality.md`.

Kiểm tra animation bằng CLI thật (3 yêu cầu; ảnh/dự án tạm tự dọn tương tự):

```powershell
node scripts/check-animation-quality.js codex --review
```

Không dùng lệnh Antigravity khi yêu cầu Codex-only của chat vẫn còn hiệu lực.
Kết quả kiểm tra thực tế và các phần chưa xác minh được ghi trong `studio-implementation.md`.

## Tileset và bản đồ platformer

1. Vẽ hoặc áp dụng một **ô vật liệu vuông 16×16 hoặc 32×32**. Ví dụ: đất, cỏ hoặc đá. Mở **Tileset từ vật liệu** ở thanh trên; chọn đúng asset/frame và cỡ ô. App không tự thu nhỏ ảnh lớn.
2. Chọn độ dày mép và cách lấy mẫu: **Lặp nguyên pixel nguồn** giữ texture; **Đối xứng texture trong ô** có thể giúp mép nối trùng nhau nhưng làm thay đổi cách lặp họa tiết. Bấm **Dựng atlas xem trước**. Bước này chạy cục bộ, không gọi CLI hay tạo 47 ảnh AI riêng.
3. Xem atlas **8×6**, gồm 47 mask địa hình và ô thứ 48 dự phòng, rồi xem mẫu nối mép/tường/lỗ. Cảnh báo đường nối chỉ để kiểm tra; app không tự sửa. Bấm **Áp dụng thành tileset mới** khi đồng ý. Atlas thành asset pixel thông thường, vẫn vẽ tay được; bản đồ sẽ dùng các pixel atlas hiện tại.
4. Mở **Bản đồ**, chọn tileset, nhập tên và số ô. Mặc định **64×32**, tối đa **256×256**. Mỗi layer dùng một tileset; các layer trong cùng bản đồ phải cùng cỡ ô. Tạo layer riêng khi muốn dùng vật liệu khác.
5. Chọn ô trong bảng bên trái rồi dùng **Bút**, **Tẩy**, **Tô vùng**. Bật **Autotile** để tự chọn góc/mép theo tám láng giềng. Tắt Autotile để đặt nguyên ID ô đã chọn; ô thứ 48 luôn là trang trí thủ công, không tham gia địa hình.
6. **Chọn vùng** bằng cách kéo hình chữ nhật. Dùng **Sao chép/Cắt**, rồi chọn vị trí và **Dán tại vùng chọn / con trỏ**. Vùng dán phải vừa bản đồ và cùng dự án/tileset. Một nét kéo là một bước Undo. **Esc**, mất focus hoặc hủy con trỏ sẽ bỏ nét đang kéo.
7. Giữ **Space** hoặc chuột giữa để kéo bản đồ; lăn chuột phóng quanh con trỏ, **1×** xem pixel gốc, **Vừa khung** đặt lại góc nhìn. Bản đồ lớn vẫn dùng zoom tối thiểu 1× và kéo để xem; không dựng toàn bộ ảnh khổng lồ vào Canvas.
8. Layer có ẩn/hiện, khóa, độ đục và thứ tự. **Va chạm ô** lưu `empty` (trống), `solid` (đặc), `one-way` (một chiều); **Xem va chạm** chỉ bật overlay, không chạy vật lý game và không xuất overlay vào PNG.

**Tải JSON** chứa dữ liệu ô thực, layer, ID tileset và va chạm; **Tải ZIP + atlas** bổ sung PNG/JSON của mọi atlas tham chiếu tại cùng revision. **Tải PNG** xuất ảnh bản đồ đã gộp layer hiện; giới hạn **4096 px mỗi cạnh**. Với bản đồ lớn hơn, dùng JSON/ZIP. **Tải tileset PNG/JSON** xuất đúng atlas cùng mapping 47 mask của pxl, không giả định thứ tự atlas của engine khác.

Bản đồ tự lưu chung với dự án sau 500 ms và xuất hiện trong nhóm **Bản đồ** bên trái. Khối ô được lưu riêng trong tài nguyên dự án và đi cùng lịch sử/sao lưu. Nếu hai tab cùng sửa, app giữ bản nháp và chặn ghi/xuất bản mới nhất cho đến khi giải quyết xung đột.

Không xóa frame hoặc đổi kích thước atlas đang được tileset sử dụng. Khi cần thay atlas, chọn tileset thay thế ở bảng layer rồi dùng **Gỡ / thay tileset…**; app báo rõ và xóa các ô cũ sau khi xác nhận, tránh dùng nhầm ID của vật liệu khác. Undo khôi phục cả liên kết và dữ liệu ô. Khi thu nhỏ bản đồ, app báo số ô bị cắt trước khi xác nhận.

Để bỏ một tileset chưa dùng, mở **Tileset từ vật liệu → Tileset đã đăng ký → Gỡ liên kết tileset chưa dùng…**. Ảnh atlas vẫn còn và có thể xóa ở danh sách asset. **Hoàn tác** khôi phục đăng ký. Nếu tileset đang được dùng, app hiển thị tên các bản đồ phụ thuộc và chặn gỡ trực tiếp.
# Chế độ chất lượng có cấu trúc (thử nghiệm)

Trong tài liệu pixel, mở **Chất lượng (thử nghiệm)** trên thanh lệnh. Chọn
frame nguồn, đánh dấu đồng ý rồi bấm **Duyệt frame hiện tại**. Sau đó nhập
mô tả và bấm **Tạo chất lượng**. Nguồn phải dùng palette của asset và alpha
0/255; nếu chưa khớp, chuẩn hóa thành bản sao rồi duyệt, app không âm thầm
đổi ảnh đang vẽ.

Để giữ layer khi duyệt nguồn tĩnh, bật **Giữ riêng các layer ảnh đang hiện**
trước khi bấm **Duyệt frame hiện tại**. Studio giữ thứ tự lớp ảnh nhìn thấy
trong frame và hiển thị số layer ở danh sách nguồn. Các lớp được giữ cần
opacity 100% và màu khớp palette của asset. Frame có nhóm layer vẫn giữ các
lớp ảnh nhìn thấy bên trong nhóm theo thứ tự khi dựng.

Với **Chỉnh từ mẫu**, tạo một vùng chọn chữ nhật trên canvas trước khi mở
**Chất lượng (thử nghiệm)**. Bật **Giữ riêng các layer ảnh đang hiện** rồi
chọn **Khóa phạm vi chỉnh** và chọn các layer được sửa trước khi duyệt.
Studio kiểm tra từng layer và ảnh tổng hợp để bảo vệ phần ngoài phạm vi.
Khi áp dụng, kết quả được lưu thành một asset có layer riêng để tiếp tục vẽ.

Ba vai chạy lần lượt. Codex lập cấu trúc, DeepSeek dựng đề xuất, Codex xem
ảnh và kiểm tra/sửa một lần. Giao diện hiện thời gian, số lượt gọi, lỗi và
**Hủy tác vụ**. Đóng bảng vẫn để tác vụ chạy; mở lại để theo dõi hoặc hủy.
Giới hạn toàn chuỗi 15 phút, tối đa bốn lần gọi provider và một lượt sửa kỹ thuật.
Không tự đổi model, tài khoản hay quyền khi có lỗi.

Chọn **Bản dựng** hoặc **Sau kiểm tra**, xem từng frame ở mức phóng nguyên,
bật onion-skin hoặc lớp khác biệt để đối chiếu. Overlay không xuất vào ảnh.
Chỉ **Áp dụng thành asset mới** mới thêm kết quả vào tài liệu; nguồn cũ được
giữ lại. Có thể tiếp tục vẽ pixel trên asset mới, lưu và tải PNG như bình thường.
Đề xuất trên revision cũ bị chặn. Lịch sử từng vai và JSON đã nhận còn đọc được
sau khi khởi động lại; ảnh preview tạm có thể không còn và không tự gọi AI lại.

**Dựng rig (thử nghiệm)** mở công cụ tách bộ phận, đặt khớp và dựng pose.
Bấm **Tạo nguồn mới** để chụp frame nhìn thấy thành asset làm việc riêng.
Kéo chọn vùng ở chế độ nghỉ, đặt tên rồi tách thành layer; dùng **Vẽ trên layer**
hoặc thêm layer vẽ bù để chỉnh bằng bộ công cụ pixel thông thường. Không suy ra
được phần cơ thể bị che từ ảnh phẳng. Sau chỉnh layer, mở rig và bấm **Làm mới
nguồn** để chụp đúng pixel mới; ảnh gốc được giữ nguyên.

Đặt khớp trên canvas, chọn khớp cha và gắn bộ phận/socket. Chỉnh góc theo frame,
thời lượng, thứ tự trước/sau và độ nhún thân; kéo khớp trong tư thế nghỉ có thể
undo một lần. Mất focus hủy thao tác kéo chưa kết thúc. **Đặt đích cả chuỗi chi**
dùng IK hai xương, giữ chiều dài và hướng bàn tay/bàn chân; đích ngoài tầm hoặc
vượt giới hạn góc sẽ báo lỗi. Nguồn/pose chưa hợp lệ không được đưa sang duyệt.

Bỏ **Hiện ảnh** để chỉ xem xương/điểm gắn và phát thử pose trước khi hoàn thiện
pixel. Chế độ này không đổi layer, dữ liệu ảnh hoặc file xuất; tắt Hiện xương
sẽ bật lại ảnh để tránh canvas trống.

Nhịp đi ngang +X là bản thử cho rig hai chân có bộ phận thật, 4–24 frame. Chọn
hai chân, tay tùy chọn, độ dài bước, nhấc chân và hạ hông. Xác nhận thay pose
trước khi dựng; giữ nguyên ID và timing. Tốc độ bước tính từ độ dài và thời
gian chu kỳ, root motion mặc định tắt. Kiểm tra từng frame để sửa nét khớp nối;
đúng hình học chưa có nghĩa animation đẹp. Tác vụ này xử lý trên máy, không gọi AI.

Mỗi frame có thể chọn riêng **Điểm tiếp đất**: mặc định của chuỗi, khớp cổ
chân hoặc socket ở cuối chân (ví dụ gót/mũi). Cách này giữ đúng điểm chống khi
lăn bàn chân. IK dùng cùng lựa chọn; socket thuộc chân khác bị từ chối. Sau
đổi điểm, kiểm tra target/pose và sửa đích bằng IK nếu cần; không tự sửa pose
để che sai số. Clip cũ không có lựa chọn riêng tiếp tục dùng socket của chuỗi.

Nếu khớp chi chỉ gắn layer rỗng, raster trong suốt hoặc bộ phận bị ẩn cả clip,
app chỉ cho lưu nháp/xem xương và báo phần cần vẽ trước khi duyệt. Walk/run có
mọi frame giống hệt RGBA cũng bị chặn. Kiểm tra này áp dụng cả ở máy chủ;
chuyển động xương dưới một pixel chưa đủ để công nhận ảnh có chuyển động.

**Duyệt nguồn chuyển động…** cho xem nguồn, bộ phận/vẽ bù, pose, timing và
khóa trước khi tạo. Vẫn có thể nhập bộ nguồn JSON có cấu trúc trong phần nâng cao,
dùng tài nguyên đã có trong dự án.
Không tự biến landmark cũ thành rig đã duyệt. Frame khóa có ảnh RGBA đối chiếu,
vùng cho phép sửa có overlay riêng. Pose sửa ngoài vùng hoặc đổi frame khóa
không được duyệt. Cần xác nhận riêng cả nguồn, bộ phận và pose.

Chế độ này chưa phải mặc định và chưa được công bố đạt chất lượng PixelLab.

## Sửa nét trên đề xuất chất lượng (bản thử nghiệm Q3)

Trong bản mã nguồn Q3, mở **Chế độ chất lượng**, chọn đề xuất đã dựng xong rồi
bấm **Sửa nét pixel…**. Runtime thử nghiệm Q3b đã mở tại localhost:4321 ngày
30/10; tải lại tab để nhận giao diện mới. Phần này chưa được công bố ổn định.

Chọn frame, màu trong palette và bút/tẩy; cỡ bút 1–64 px. Kéo một nét rồi
Undo/Redo để kiểm tra. Phím công cụ và Undo/Redo dùng cấu hình phím đang lưu
trên máy; ô nhập vẫn nhận phím bình thường. Mất focus sẽ hủy nét chưa thả.

**Khóa frame tốt** bảo vệ frame so với biến thể trước sửa. Frame nguồn đã khóa
không bỏ khóa được. Muốn khóa frame vừa chỉnh, lưu biến thể trước. Nhập X/Y/
rộng/cao rồi bấm **Giới hạn vùng sửa**; vùng này chỉ thu hẹp phần đã được phép
sửa. Onion/diff/vùng khóa chỉ là lớp xem, không xuất vào ảnh.

**Lưu biến thể** dựng lại cục bộ, không gọi AI và chưa đổi dự án. Sau khi xem,
bấm **Áp dụng thành asset mới** ở màn hình đề xuất, rồi tải PNG/GIF/strip/atlas
như các asset khác. Bản gốc vẫn giữ trong danh sách biến thể. Mỗi biến thể sửa
tối đa 8 frame, 8192 điểm sửa/frame; app báo rõ khi vượt giới hạn.

Bản nháp được giữ trong IndexedDB của trình duyệt sau 500 ms ngừng sửa và khi
đóng bảng. Mở lại cùng project/lượt tạo/biến thể/revision để khôi phục. Lỗi
lưu hoặc revision đổi giữ bản nháp và chặn áp dụng lên nguồn mới. Preview
server vẫn là dữ liệu tạm; hãy áp dụng thành asset trước khi đóng server.
Khi lưu bị xung đột, **Tải frame nháp PNG** giữ được frame đang sửa ở kích
thước gốc, không có overlay, để nhập lại thành asset mới khi cần.

## Agent API/CLI

Khi Studio chạy cục bộ, dùng `pxl agent capabilities` hoặc truyền JSON v1 vào
`pxl agent call`. Agent đọc project và version đã lưu, kiểm style kỹ thuật
và nguồn Scene, rồi xuất ZIP bằng cùng worker của Studio. Các thao tác ghi
yêu cầu token và expected revision. Việc duyệt đề xuất từ Engine tiếp tục
qua Studio. [Quyền Agent và ví dụ CLI](../SECURITY.md)
