# Bảo mật và báo lỗi

Studio và Agent phục vụ trên loopback. Studio kiểm Host và Origin khi ghi. Dùng `--root` để chọn đúng workspace trên máy cục bộ.

Agent ghi qua bearer token `LUMASPRITE_AGENT_WRITE_TOKEN`, thao tác được hỗ trợ và revision khớp. Token có 32–256 ký tự ASCII in được, trừ dấu cách. Lệnh rollback áp dụng cho mutation mới nhất trong cùng phiên Studio với revision khớp. External Engine đưa đề xuất raster vào màn hình duyệt để người dùng chọn áp dụng.

Lưu nguyên manifest, cel và resource khi sao lưu dự án. Khi báo lỗi cho người quản trị repo, gửi phiên bản Node, hệ điều hành và bước tái hiện bằng dữ liệu mẫu. Che token và dữ liệu cá nhân trong log hoặc ảnh đính kèm.

[Hướng dẫn Agent và External Engine](docs/STUDIO.md)
