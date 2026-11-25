# Audit Raster Native

Ngày 25/11/2026. Build **`raster-native-20261125.16ed10f60040`**, Node **24.22.3**, Windows và Chrome. Định danh lấy từ SHA-256 của manifest 57 tệp `dist/` trong gói cài thử. RC02 là bản lịch sử. Nghiệm thu chức năng của Raster Native chờ Project Owner.

## Phụ thuộc và tương thích

- CLI `lumasprite` tải `dist/node/cli.js`. Mô-đun package xuất `serveStudio` và đường dẫn Agent v1. Worker giữ các chế độ pixel-export, terrain và production. Browser chỉ gửi lệnh dự án raster, terrain, production và External Engine. Route xem trước mã cũ và Live Viewer trả 404.
- Đã gỡ 275 tệp trong lần tách ban đầu, gồm `src/core/`, DSL, trình nạp mã, CLI PXL, Live Viewer, AI/PoseSpec/Quality generation, ví dụ, gallery và skill. Mã chạy có raster RGBA, PNG/GIF/atlas, Worker và CLI mới. `acorn`, `eslint-scope` và CodeMirror đã rời dependency trực tiếp. Package có 0 runtime dependency npm và 70 tệp. Bản build bỏ polyfill modulepreload không dùng.
- `pxl.project.json`, `.pxl/`, metadata có sẵn, khóa tùy chọn trình duyệt và alias biến môi trường cũ phục vụ tương thích v2. Asset đính kèm source giữ text dưới dạng metadata. External Engine v1 nhận/trả raster. Universal Pixel Art Engine chịu trách nhiệm phát triển phương pháp sinh và chất lượng mỹ thuật.
- Giấy phép MIT của PXL và attribution của skill vẫn đi cùng mã tương ứng ở initial commit và bản lưu. Đã rà các entrypoint, worker, dependency và payload đóng gói hiện hành. Gói native không chứa renderer, ví dụ, skill hoặc notice PXL. Dependency phát triển và kiểm thử dùng giấy phép trong các gói tương ứng. Hai archive RC02 khớp SHA-256 trong manifest lịch sử.

## Đối chiếu kiểm thử

| Hạng mục | RC02 lịch sử | Raster Native và cách kiểm |
| --- | --- | --- |
| Node | 619 đạt, gồm 3 ca corpus Q2 | 97 đạt, 93 ca cùng tên, 2 ca cập nhật hợp đồng và 2 ca mới cho nhập PNG |
| Chrome | 127 đạt, gồm 1 ca corpus R4 | 39 đạt, 38 ca cùng tên. Ca nhập PNG/sheet tách khỏi phép thử AI cũ. Ca External Engine kiểm thêm thời gian giữ phản hồi apply |
| Ví dụ PXL | 13/13 | Chạy fixture tương thích trên runtime RC02 đã lưu. DSL và ví dụ đã rời bản native |
| Ca bị loại theo chức năng | DSL, render nguồn, live viewer, AI/provider, rig/clip thử nghiệm và Quality | Phần quản lý v2, playback, asset library, export và hợp đồng raster giữ kiểm thử riêng |
| Dữ liệu local và skip | `quality-static-source.test.ts` và `rig-approved-art.spec.ts` dùng corpus riêng | Hai tệp lịch sử đã bị Git ignore từ initial commit, phụ thuộc runtime đã gỡ và được tách khỏi discovery local. Full suite có 0 skip. Hai kiểm thử Node về junction chỉ skip khi hệ điều hành từ chối tạo junction |
| Khoảng trống | FG performance và nguồn artwork do Owner chọn có bằng chứng theo từng RC | Lượt này chưa chạy F10 foreground, Linux, macOS hoặc engine thật. Hai dự án cá nhân dùng trong smoke chỉ có bản sao local. Migration RC02 được kiểm bằng fixture tổng hợp |

| Workflow native | Kiểm thử hiện hành |
| --- | --- |
| Editor, layer, mask, undo/redo và animation | `pixel.test.ts`, `editor-polish.spec.ts`, `pixel.spec.ts`, `quality-playback.test.ts` |
| Terrain, tilemap, camera và viewport | `terrain-api.test.ts`, `tilemap-render.test.ts`, `tilemap-store.test.ts`, `tilemaps.test.ts`, `terrain-map.spec.ts` |
| Production Library, Scene Preview và Style Profiles | `asset-library.test.ts`, `production.test.ts`, `production.spec.ts` |
| External Engine, vùng khóa và duyệt | `engine-adapter.test.ts`, `external-engine.test.ts`, `external-engine.spec.ts` |
| Agent API và CLI | `agent-api.test.ts`, kiểm gói cài |
| Save/reopen, backup/restore, revision và integrity | `pixel.test.ts` và các kiểm thử `*resource*verification*`, smoke hai bản sao v2 |
| PNG, GIF và atlas | `pixel.test.ts`, `png-import.test.ts`, `production.test.ts`, kiểm PNG đậm/alpha và timing qua migration |

Các ca hợp đồng Agent kiểm capabilities, project, asset/version, xác thực token, quyền ghi, expected revision, ZIP, rollback và diagnostic có cấu trúc. Mock Engine kiểm kết nối, metadata, digest, alpha, mask, approve/reject, timeout, stale, apply, undo/redo, mở lại và PNG. Studio từ chối preview làm đổi ngoài mask hoặc pixel khóa.

## Lỗi đã xác nhận và kiểm lại

- **Tilemap.** Ca “partial stroke repaint and erase match a full viewport repaint before commit” từng thấy `data-paint-kind="unchanged"` trong log trước và sau lần tách. Render được gộp theo animation frame. Khi một lượt vẽ ô đã thành công, lượt vẽ kế tiếp có thể không còn vùng bẩn và ghi lại trạng thái tức thời. Kiểm thử nay đếm các lần vẽ partial đã quan sát qua `MutationObserver`, chờ pixel ở ô đầu và cuối thay đổi, rồi đối chiếu hash của canvas với lượt vẽ lại toàn bộ trước khi commit. Browser context và thư mục dự án test được cấp riêng. Test camera, tải chunk muộn, pane resize và xung đột revision cũng đạt. Full suite đạt và ca này qua 6/6 lượt lặp.
- **External Engine.** Giữ phản hồi sau khi server đã lưu từng để nút đóng còn hoạt động. Studio chặn nút đóng và sự kiện hủy modal cho tới khi nhận revision và cập nhật undo. Chrome kiểm response bị giữ, rồi tiếp tục export, undo/redo, reopen và rollback.
- **PNG.** Chromium qua Canvas làm pixel legacy RGBA `[28,45,62,85]` thành `[27,45,63,85]`. Đường nhập PNG non-interlaced 8-bit RGBA/indexed nay giải nén và đọc trực tiếp với kiểm tra checksum. Toàn bộ RGBA của fixture khớp sau nhập/xuất. Các định dạng PNG khác vẫn đi qua bộ giải mã trình duyệt.

## Tương thích và điều kiện bàn giao

- **Raster v2** · Hai bản sao qua open, sửa pixel, thêm layer/frame, thời lượng mới, save/reopen, undo/redo, PNG và nhập backup thành project mới. Pixel frame gốc, metadata và resource được đối chiếu. 480 tệp từ hai dự án nguồn giữ nguyên SHA-256 qua phép thử.
- **Legacy** · CLI trong RC02 đã lưu dựng fixture `.px.js` thành PNG tĩnh và strip hai frame. PNG tĩnh, pixel từng frame và GIF xuất lại khớp. Studio nhập frame mặc định 100 ms. Đặt lại 70/130 ms theo JSON rồi kiểm GIF. PNG chỉ mang ảnh composite, dự án nguồn tiếp tục giữ layer, mã, tag/loop và metadata game.
- **Gói cài** · Cài offline, chạy CLI và BAT với thư mục Unicode, kiểm project, Agent và worker PNG. Đã kiểm 14 liên kết nội bộ trong README và STUDIO.md ở cả cây nguồn lẫn gói cài.
- **Nghiệm thu đề xuất** · Owner chạy một bản sao dự án v2 thực tế qua Editor, Timeline, Tilemap, Production, External Engine và backup. Dùng cùng build ID để ghi kết quả F01–F10. Nghiệm thu mỹ thuật của engine là quyết định riêng.
