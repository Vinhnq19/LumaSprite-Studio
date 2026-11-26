# LumaSprite Studio — Independent Art Review Workbench

## 1. Architecture Audit

### Studio Components Reused
- **`src/studio/raster.ts`**: `channels`, `luma8`, and `toHex` for big-endian `0xRRGGBBAA` pixel unpacking and luminance dimming without modifying Studio raster primitives.
- **`src/studio/quality/playback.ts`**: `sampleMotionPlayback` for wall-clock animation frame sampling so late browser timers never stretch frame durations.
- **`studio/pixel/read-png.ts`**: `readStudioPng` for exact straight-alpha 8-bit RGBA and indexed+`tRNS` PNG decoding (avoiding Chromium's Canvas premultiply/round-trip drift such as `[28,45,62,85] -> [27,45,63,85]`).
- **Studio Design Tokens & Modal Pattern** (`studio/pixel/style.css`): dark surface palette (`#12171f`, `#1a212c`, `#303b4c`, `#80c99b`), `.large-workspace` dialog styling, and `image-rendering: pixelated` discipline.

### Independent Architecture & Isolation Boundaries
- **Core modules (`src/studio/art-review/`)** have zero DOM dependencies and zero imports from `D:\LumaSprite-Engine`, External Engine Adapter, or Production Workspace:
  - `types.ts`: Schema, asset families (all 7 families), alignment, animation, rubric, and review report types.
  - `pixel-ops.ts`: Non-mutating RGBA inspection, size/pivot mismatch checks, integer-offset alignment layout (zero auto-scaling), exact Pixel Diff (`rgbDiffPixels`, `alphaDiffPixels`, `onlyAPixels`, `onlyBPixels`), frame-to-frame diff, binary/alpha-channel silhouette extraction, and sprite strip slicing.
  - `metadata.ts`: Safe parser for Studio strip/atlas JSON, Aseprite JSON, frame-timing JSON, bare timing arrays, and minimal review manifests. Preserves real JSON durations (`1..60000` ms) and rejects invalid/missing timing rather than defaulting to `100` ms.
  - `animation-sync.ts`: `forward` / `reverse` / `ping-pong` expansion, wall-clock synchronized A/B playback (warning when timings differ instead of assuming frame index correspondence), and loop-boundary `[last, first]` extraction.
  - `rubrics.ts`: Workbench-default rubrics across all 7 asset families (`character`, `prop`, `terrain`, `environment`, `animation`, `ui`, `vfx`), custom rubric JSON validation, and non-averaging defect summaries.
  - `report.ts`: Review JSON (`lumasprite.art-review.v1`) serialization/validation and Markdown report generation without automatic `Artistic PASS`.
- **Browser modules (`studio/pixel/art-review/`)**:
  - `png-decode.ts`: Local PNG signature/IHDR verification, SHA-256 hashing, and straight-alpha pixel extraction.
  - `viewer.ts`: `ComparisonViewer` managing integer-zoom (`1×`, `2×`, `4×`, `8×`) nearest-neighbor rendering, synchronized pan/zoom, Side-by-side, Toggle A/B, Blink A/B, Pixel Diff, Silhouette/Alpha, Checkerboard/Light/Dark backgrounds, pixel grid, pivot crosshair, onion-skin, frame diff overlay, and live RGBA inspection.
  - `workbench.ts` & `workbench.css`: Standalone `ArtReviewWorkbench` modal launched from `#art-review-open` in `studio/pixel/app.ts` without requiring any open project or backend/Engine server.
- **Unmodified Zones**: `D:\LumaSprite-Engine` (untouched), Pixel Core (`src/studio/pixel/*`), Production Workspace (`src/studio/production.ts`, `studio/pixel/production-workspace.ts`), Terrain/Map editors, External Engine, `package.json`, and all existing test suites.

---

## 2. Hướng dẫn sử dụng (Usage Guide)

1. **Mở công cụ:** Nhấn nút **Art Review** trên thanh điều hướng chính của Studio (hoạt động ngay cả khi chưa mở dự án), chọn từ Tìm lệnh (`/`) `Mở Art Review Workbench`, hoặc truy cập `?workbench=art-review` / `#art-review`.
2. **Nạp tài sản A (Baseline) & B (Candidate):**
   - Kéo thả hoặc bấm **Mở PNG** để nạp ảnh tĩnh hoặc sprite strip cục bộ (không upload ra ngoài).
   - Bấm **Timing/Meta JSON** để nạp thời lượng frame thật, pivot và tag từ JSON. Nếu cắt strip thủ công theo ô W×H khi chưa có JSON, hệ thống ghi rõ nhãn `cắt tay 100ms`.
   - Nếu đang mở dự án trong Studio, có thể chọn nhanh **Từ dự án** để chụp snapshot read-only của asset (không sửa tài liệu gốc).
3. **So sánh pixel chính xác:**
   - Chọn chế độ **Song song**, **Chỉ A**, **Chỉ B**, **Blink A/B** (250/500/800 ms), **Pixel Diff**, hoặc **Silhouette / Alpha** (`Silhouette alpha > 0` hoặc `Kênh Alpha 0–255`).
   - Phóng đại nguyên lần **1× / 2× / 4× / 8×** (`imageSmoothingEnabled = false`), kéo chuột để pan đồng bộ A/B, đổi nền **Checkerboard / Nền tối / Nền sáng**.
   - Nếu A và B khác kích thước hoặc pivot, thanh cảnh báo căn chỉnh sẽ hiện; chọn chế độ căn (`Tâm ảnh`, `Đáy giữa`, `Theo Pivot`, hoặc `Tọa độ tay`) và tick **Xác nhận căn chỉnh** trước khi kết luận Pixel Diff.
   - Di chuột lên canvas để đọc tọa độ và **RGBA (0–255) + Hex** đồng thời của A và B; nhấp chuột trái để khóa/mở khóa điểm đo.
4. **Đánh giá Animation:**
   - Bấm **▶ Phát**, **◀ Frame / Frame ▶**, **Về đầu**, bật/tắt **Lặp (Loop)** (hoặc bỏ tick để kiểm **One-shot**).
   - Khi A và B có số frame hoặc tổng duration khác nhau, chế độ mặc định **Theo thời gian phát (ms)** giữ nhịp đồng bộ theo thời gian thực và hiển thị cảnh báo rõ ràng.
   - Bật **Onion-skin**, **Frame diff**, **Pivot** hoặc **Biên lặp (Last → First)** để soi độ mượt vòng lặp.
5. **Chấm điểm & Xuất báo cáo:**
   - Chọn **Asset family** (`Character`, `Prop`, `Terrain`, `Environment`, `Animation`, `UI`, `VFX`), chấm điểm từng tiêu chí, đánh dấu mức lỗi (`Minor`, `Major`, `Critical`), bật **Ghim nhận xét vùng** rồi nhấp lên canvas để ghim lỗi theo tọa độ.
   - Chọn quyết định của người đánh giá: **Chọn A**, **Chọn B**, **Neither**, hoặc **Chưa kết luận** (không bao giờ tự đánh dấu Artistic PASS).
   - Bấm **Xuất Review JSON** hoặc **Xuất Markdown**; dữ liệu phiên tự lưu tạm trong `localStorage` khi chuyển tab hoặc tải lại trang.

### Phím tắt trong Workbench
- `1`, `2`, `4`, `8`: Đổi zoom 1× / 2× / 4× / 8×
- `T`: Chuyển qua lại Chỉ A / Chỉ B (`A` = Chỉ A, `B` = Chỉ B)
- `K`: Blink A/B · `D`: Pixel Diff · `S`: Silhouette / Alpha
- `G`: Bật/tắt lưới (khi zoom ≥ 4×) · `P`: Bật/tắt Pivot · `O`: Bật/tắt Onion-skin
- `Space`: Phát / Tạm dừng animation · `←` / `→`: Lùi / Tiến 1 frame

---

## 3. Technical QA & Known Limitations

- **Typecheck (`npm run typecheck`)**: PASS (0 errors under TypeScript 7 strict/NodeNext).
- **Build (`npm run build`)**: PASS (`dist/` + Vite studio bundle).
- **Unit Tests (`npm test`)**: 103/103 PASS (98 existing Studio tests + 5 new Art Review test suites in `test/art-review-workbench.test.ts`, 0 skipped).
- **Browser E2E (`npm run test:studio-ui`)**: Verified across Chrome desktop viewports (`1280×720`, `1366×768`, `1440×960`).

### Known Limitations
1. **Local Reload Sprite Cache Cap**: Persisting loaded PNG bytes in browser `localStorage` is capped at `256 KiB` per slot to stay well below browser quota. Review scores, notes, decisions, and SHA-256 references still persist across reload for larger sheets, while the user is prompted to re-pick PNGs larger than `256 KiB` after a full page reload.
2. **PNG Decoding Fallback**: Non-interlaced 8-bit RGBA and indexed+`tRNS` PNGs use Studio's direct PNG decoder (`readStudioPng`) for guaranteed bit-exact straight-alpha preservation; exotic PNG variants (e.g. 16-bit/interlaced) fall back to `createImageBitmap({ premultiplyAlpha: 'none', colorSpaceConversion: 'none' })`.
3. **Local-Only Persistence**: By isolation design, reviews are exported as local JSON/Markdown artifacts and cached in `localStorage` rather than mutating Studio `.pxl/` project revisions or Production approval state.

---

## 4. Proposal: Non-Invasive Integration with Codex E7 (Post-Completion)

Once Codex finalizes `E7.0–E7.1` in `LumaSprite-Engine`, the Workbench can connect cleanly through **pure JSON/file adapters** without coupling its core viewer or human-scoring logic to Engine internals:
1. **Rubric Adapter (`E7 Contract -> Workbench Rubric JSON`)**: Write a small translator script/endpoint in the integration layer that maps finalized E7 `Universal Quality Contract v1` criteria per asset family into the Workbench's `RubricDefinition` JSON format and loads it via **Nạp Rubric JSON**.
2. **Candidate Intake (`E7 Bundle -> Manifest JSON`)**: Have E7 emit a `lumasprite.art-review-manifest.v1` JSON alongside baseline/candidate PNG strips and timing JSONs so the Project Owner can load an entire E7 review pair in one step without running Engine live inside the Workbench.
3. **Decision Handoff (`Review JSON -> E7 Ledger`)**: Feed exported `lumasprite.art-review.v1` JSON (which carries `sourceSha256`, `timestamp`, `toolVersion`, `decision`, `criticalDefectCount`, and per-criterion scores) into E7's acceptance ledger as the authoritative human sign-off record.
