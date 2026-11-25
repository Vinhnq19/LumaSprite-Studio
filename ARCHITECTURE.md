# Kiến trúc LumaSprite Studio

| Thành phần | Điểm vào | Vai trò |
| --- | --- | --- |
| Web | `studio/pixel/app.ts` | Pixel Editor, timeline, thư viện, tilemap, Production và màn hình duyệt External Engine |
| Raster | `src/studio/raster.ts`, `src/studio/pixel/model.ts` | Pixel RGBA, composite layer và thứ tự phát |
| Dữ liệu | `src/node/studio/pixel-store.ts` | Project v2, revision, blob cel và resource, lịch sử, phục hồi |
| Tilemap | `src/studio/tilemaps.ts`, `src/studio/tilemap-render.ts` | Chunks, atlas, tile ID và dựng thumbnail/PNG |
| Xuất | `src/node/studio/worker.ts`, `src/node/studio/pixel-render.ts` | PNG, GIF, strip, atlas và gói Production |
| Tích hợp | `src/studio/engine-adapter.ts`, `src/studio/agent-contract.ts` | Đề xuất raster từ engine cục bộ và các thao tác Agent có revision |

Studio lưu canvas và cel dưới dạng raster. Worker dùng cùng bộ composite với giao diện để xuất pixel nguyên bản. Các metadata trò chơi đi cùng PNG hoặc JSON khi định dạng hỗ trợ.

Dự án v2 tiếp tục dùng `pxl.project.json` và `.pxl/` để giữ tương thích với bản lưu cũ. Source đính kèm trong bản v2 được lưu như metadata. External Engine gửi dữ liệu theo hợp đồng raster v1.
