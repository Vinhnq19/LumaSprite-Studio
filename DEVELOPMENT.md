# Phát triển và kiểm thử

Cài Node.js 22.18 trở lên và Chrome. Chạy các lệnh sau từ thư mục gốc checkout.

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run test:studio-ui
node scripts/check-examples.js
```

`npm ci` chạy `prepare` và build. `npm run build` có thể chạy lại khi cần. `npm run studio` chạy Studio từ checkout, `npm run studio:dev` chạy Vite. Trên Windows, `start-studio.bat` dùng bản build đã có. Dùng `--root` trỏ sang thư mục test riêng để thử save, restore và export.

## Workflow thay đổi

- Dùng TypeScript và Node ESM theo module gần nhất. Giữ revision, khóa vùng pixel và kiểm tra đường dẫn ở API/store. Giữ `package-lock.json` đi cùng thay đổi dependency.
- Kiểm fixture cục bộ cho lỗi có thể tái hiện. Chạy regression Node và Chrome với Engine mock hoặc provider fixture. `studio/test-server.ts` cung cấp mock và root tạm. Giữ asset, token và log cá nhân trong thư mục local đã ignore.
- Khi đổi schema, duy trì parser cho dữ liệu đã lưu hoặc có đường migration và backup rõ ràng. Giữ API/CLI đã công bố cùng contract tests. Khóa release mới và lưu hash nguồn, `dist` và archive nếu byte build thay đổi.
- Hai regression lịch sử phụ thuộc corpus artwork đánh giá cục bộ nằm ngoài danh sách GitHub. Maintainer có quyền dùng corpus có thể đặt lại `game-feasibility/`, `test/quality-static-source.test.ts` và `studio/e2e/rig-approved-art.spec.ts` theo đúng cây cũ rồi chạy vòng hồi quy bổ sung. Các fixture tổng hợp cho renderer và rig vẫn nằm trong bộ test của checkout.

[Kiến trúc](ARCHITECTURE.md) · [Bảo mật](SECURITY.md) · [Hướng dẫn Studio](docs/STUDIO.md)
