# Sử dụng LumaSprite Studio

## Vẽ và làm animation

Tạo dự án pixel, chọn kích thước hoặc nhập PNG. Khi nhập sprite sheet, chọn kích thước ô, lề, khoảng cách và thứ tự frame. Dùng canvas để vẽ, chọn, cắt, dán và chỉnh layer. Lưới, nền và mức zoom chỉ điều khiển cách hiển thị. Đổi canvas hoặc co giãn ảnh bằng công cụ trên thanh canvas.

Timeline hỗ trợ frame mới, nhân bản liên kết hoặc độc lập, tách cel, onion-skin và thời lượng từng frame. Tag phát hỗ trợ chiều xuôi, ngược và ping-pong. Chọn tag khi xuất GIF hoặc strip.

## Terrain và Tilemap

Từ asset vật liệu, chọn dựng tileset, kiểm preview rồi áp dụng. Thao tác vẽ map lưu tile ID theo layer và hỗ trợ autotile, khóa layer, chọn vùng và metadata collision. Xuất PNG hoặc gói JSON/ZIP khi cần dữ liệu tile của game.

## Production và External Engine

Production quản lý thư viện, collection, loại asset, phiên bản và Style Profile. Dùng Scene Preview để xem sprite trên map trước khi xuất gói dự án game.

Đặt `LUMASPRITE_ENGINE_PORT` thành cổng của External Engine tại localhost trước khi mở Studio. Trong **External Engine**, nhập brief hoặc chọn vùng khi engine hỗ trợ. Kiểm preview rồi áp dụng bằng nút trong giao diện. Có thể thử luồng kết nối bằng `node scripts/mock-external-engine.mjs` và dùng cổng mà lệnh in ra.

## Sao lưu và xuất

Studio lưu vào workspace đã chọn. Khi gặp xung đột revision, có thể tải lại hoặc lưu bản sao của bản nháp. Dùng **Lịch sử** để khôi phục snapshot. Dùng **Sao lưu ZIP** để tạo bản sao đầy đủ. Để nhập lại, giải nén và chọn thư mục bằng **Mở sao lưu**.

Dự án raster v2 giữ canvas, layer, animation, tài nguyên và metadata cũ.

### Chuyển dự án mã `.px.js`

1. Dùng Studio legacy đã lưu để xuất PNG hoặc sprite sheet kèm JSON. Giữ bản gốc và JSON bên cạnh ảnh.
2. Nhập PNG vào Studio. Với strip, dùng kích thước ô và thứ tự từ JSON.
3. Mỗi frame nhập mặc định 100 ms. Đặt lại thời lượng từ trường `duration` trong JSON, rồi chọn tag và chiều phát nếu cần.
4. PNG giữ ảnh đã composite. Layer, cel liên kết, quy tắc dựng từ mã, tag/loop và các metadata game như pivot, hitbox, event hoặc collision cần dựng lại khi có dữ liệu gốc.

PNG mà Studio và RC02 xuất có kênh RGBA 8-bit hoặc bảng màu 8-bit. Khi nhập hai định dạng này ở chế độ non-interlaced, Studio đọc kênh alpha trực tiếp. Các dạng PNG khác dùng bộ giải mã của trình duyệt. GIF dùng tối đa 256 màu và alpha nhị phân theo định dạng. Pixel Editor cũng xuất strip/atlas với JSON và ZIP cho asset đã chọn.

## Agent

```sh
node bin/lumasprite.js agent --help
node bin/lumasprite.js agent capabilities --port 4321
```

Gửi JSON qua stdin cho `agent call`. Agent đọc dữ liệu đã lưu. Nếu bật ghi, đặt cùng `LUMASPRITE_AGENT_WRITE_TOKEN` trong môi trường Studio và CLI. Chạy `agent capabilities` để xem thao tác và trường đầu vào. [Quy tắc bảo mật](../SECURITY.md)
