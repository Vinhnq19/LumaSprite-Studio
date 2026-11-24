# Bảo mật và báo lỗi

Studio và Agent phục vụ HTTP tại loopback. Agent CLI kết nối tới `127.0.0.1`. Studio kiểm Host và Origin cho các yêu cầu ghi liên quan. Hãy giữ Studio trong phạm vi máy cục bộ được tin cậy và dùng `--root` để giới hạn workspace. Trước khi đưa project thử cho người khác, chọn bản sao riêng với dữ liệu mẫu.

## Agent API/CLI

- Các thao tác đọc lấy project đã lưu. Gói ZIP được xử lý cục bộ và có digest SHA-256.
- Thao tác ghi dùng bearer `PXL_AGENT_WRITE_TOKEN`, ID hợp lệ, payload đúng schema và expected revision. Cấu hình token 32–256 ký tự ASCII in được, trừ dấu cách, khi khởi động Studio và truyền cùng giá trị trong môi trường của CLI. Có thể nhập kín bằng `Read-Host -MaskInput` trên PowerShell 7. Xóa biến phiên khi xong.
- Gửi đề xuất engine và áp dụng tiếp tục qua giao diện với thao tác duyệt. Rollback Agent áp dụng cho mutation mới nhất cùng phiên Studio với revision khớp.

```powershell
node bin/pxl.js agent capabilities --port 4321
'{"version":1,"operation":"projects.list","input":{}}' | node bin/pxl.js agent call --port 4321
```

Giữ `PXL_AGENT_WRITE_TOKEN`, `PXL_DEEPSEEK_API_KEY` và cấu hình provider trong môi trường cục bộ được cấp quyền. Để backup, giữ cùng manifest, blob và `.pxl/`. Kiểm tra SHA-256 khi nhận archive.

## Báo lỗi

Gửi riêng cho Project Owner hoặc quản trị viên repository. Kèm Build ID, OS/Node, vùng chức năng, bước tái hiện bằng fixture, kết quả mong đợi và tác động. Che token, thông tin cá nhân và dữ liệu project trước khi đính ảnh hoặc log. Nếu credential đã lộ, thu hồi hoặc xoay credential trước khi xử lý lịch sử Git.

[Hợp đồng Agent v1](src/studio/agent-contract.ts) · [Xác thực Agent](src/node/studio/agent-api.ts) · [Engine Adapter](src/studio/engine-adapter.ts)
