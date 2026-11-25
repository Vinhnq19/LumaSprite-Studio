# LumaSprite Studio

<img src="docs/brand/lumasprite.png" width="96" height="96" alt="Logo LumaSprite Studio">

Xưởng vẽ pixel art và animation cho game. Studio chạy trên localhost, dùng giao diện tiếng Việt và lưu dự án trên máy.

- **Pixel Editor** với canvas tùy chỉnh, layer, nhóm, bảng màu, vùng chọn và phím tắt.
- **Animation** với timeline, cel liên kết, onion-skin, thời lượng frame và tag phát.
- **Terrain và Tilemap** với dựng atlas từ vật liệu, bản đồ nhiều layer và metadata collision.
- **Production** với thư viện asset, collection, Style Profile, xem cảnh và gói xuất.
- **External Engine và Agent** qua hợp đồng raster và API JSON cục bộ. Xem đề xuất trước khi áp dụng.
- **Lưu và xuất** với lịch sử, sao lưu, PNG, GIF, strip, atlas và ZIP.

## Khởi động

Cần Node.js 22.18 trở lên và trình duyệt hiện đại.

```sh
npm ci
npm run studio
```

Trên Windows, có thể mở [start-studio.bat](start-studio.bat) sau khi cài. Studio mặc định mở tại cổng 4321 và dùng thư mục `projects/`.

```sh
node bin/lumasprite.js studio --root ./projects --port 4321
node bin/lumasprite.js agent capabilities --port 4321
```

Dự án raster v2 và các bản sao lưu v2 mở trực tiếp. Với dự án chỉ có mã `.px.js`, dùng bản Studio cũ đã lưu để xuất PNG hoặc sprite sheet rồi nhập ảnh vào bản mới. Universal Pixel Art Engine là dự án riêng. Studio nhận đề xuất qua External Engine Adapter.

[Hướng dẫn](docs/STUDIO.md) · [Kiến trúc](ARCHITECTURE.md) · [Phát triển](DEVELOPMENT.md) · [Bảo mật](SECURITY.md)
