# Phát triển và kiểm thử

Dùng Node.js 22.18 trở lên. Cài Chrome để chạy hồi quy giao diện.

```sh
npm ci
npm run check
npm run test:studio-ui
npm pack
```

`npm ci` chạy `prepare` để dựng `dist/`. Có thể dựng lại với `npm run build`. Dùng `npm run studio -- --root ./projects-test` để thử save, restore và export với dữ liệu riêng. `npm run studio:dev` chạy UI Vite với API Studio tại cổng 4321.

Test Chrome dùng thư mục dữ liệu tạm và External Engine giả lập cục bộ. Kiểm tra hợp đồng Agent, revision, tính toàn vẹn tài nguyên và RGBA trước khi đóng gói. Cập nhật `package-lock.json` cùng thay đổi dependency.
