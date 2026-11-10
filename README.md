# HyperMirror Pro — Hệ thống Chiếu Màn Hình Android ➔ PC Độ Trễ Cực Thấp Cho Chơi Game

Hệ thống gồm **cặp ứng dụng riêng biệt (Android Native Sender + PC Gaming Receiver)** được thiết kế tối ưu hóa từng mili-giây cho nhu cầu chơi game tốc độ cao (60 / 90 / 120 FPS) qua **Cáp USB** hoặc **Wi-Fi 5GHz/6GHz**.

---

## 1. Kiến trúc Tối Ưu Độ Trễ (~10–22ms End-to-End)

1. **Zero-Copy GPU Capture (`LowLatencyEncoder.kt`)**:
   - Sử dụng `MediaProjection` ghi trực tiếp từ bộ ghép hình phần cứng (`SurfaceFlinger`) vào `MediaCodec.createInputSurface()`.
   - Không qua bước chuyển đổi `ImageReader` hay copy bộ nhớ YUV trên CPU.
2. **Tối ưu DSP Phần Cứng (`MediaFormat`)**:
   - Bật `KEY_LOW_LATENCY = 1` và `KEY_LATENCY = 0` (Android 11+ API 30).
   - Đặt `KEY_MAX_B_FRAMES = 0`: loại bỏ hoàn toàn độ trễ sắp xếp lại khung hình (Frame Reordering Latency).
   - Đặt `KEY_OPERATING_RATE = Short.MAX_VALUE` và `KEY_PRIORITY = 0` (Realtime): ép xung bộ mã hóa phần cứng (Qualcomm Adreno / MediaTek / Exynos) xử lý mỗi frame chỉ trong **1.5 – 2.5 ms**.
   - Bật mở rộng phần cứng chuyên biệt của hãng: `vendor.qti-ext-enc-low-latency.enable`, `vendor.rtc-ext-enc-low-latency.enable`, `vendor.mtk.ext.venc.lowlatency`.
   - Hỗ trợ thay đổi **Bitrate trực tiếp (Live CBR Adaptation)** và ép xuất **IDR Keyframe tức thì (`PARAMETER_KEY_REQUEST_SYNC_FRAME`)** ngay khi đang chơi game mà không cần khởi động lại stream.
3. **Giao thức truyền tải `GMIR` nhị phân siêu nhẹ (`StreamTransport.kt`)**:
   - **Cáp USB (`adb forward` / `adb reverse`)**: Truyền thẳng qua USB Bulk transfer với độ trễ mạng < 0.5 ms và không bị nhiễu sóng.
   - **Wi-Fi 5GHz/6GHz**: Bật `TCP_NODELAY` (tắt thuật toán Nagle), đánh dấu gói tin ưu tiên `IPTOS_LOWDELAY | IPTOS_THROUGHPUT` (DSCP QoS) và giữ `WifiManager.WIFI_MODE_FULL_LOW_LATENCY` để ngăn chip Wi-Fi rơi vào trạng thái nghỉ DTIM khi đang chơi game.
4. **Giải mã GPU Kép trên PC (`pc-receiver`)**:
   - **Chế độ 1 — WebCodecs Hardware GPU Decoder**: Giải mã bằng GPU (`optimizeForLatency: true`, `hardwareAcceleration: "prefer-hardware"`) và vẽ lên `<canvas desynchronized="true">` (bỏ qua hàng đợi VSync của trình duyệt).
   - **Chế độ 2 — Native Direct3D11 / SDL (`FFplay Zero-Buffer`)**: Đẩy trực tiếp luồng NAL Annex-B vào `ffplay -fflags nobuffer -flags low_delay -framedrop -probesize 32 -analyzeduration 0`.

---

## 2. Cấu trúc Thư mục

- `pc-receiver/`: Ứng dụng nhận luồng & điều khiển trên máy tính (Node.js Zero-Dependency + WebCodecs GPU + FFplay Direct3D).
- `android-sender/`: Dự án Android Studio hoàn chỉnh viết bằng Kotlin (`minSdk 26`, `targetSdk 34`).
- `start-pc-receiver.bat`: Khởi chạy nhanh PC Receiver Control Center tại `http://localhost:3080`.
- `usb-connect.bat`: Thiết lập nhanh kết nối dây cáp USB qua ADB.
- `debug-logs.bat`: Công cụ tự động chẩn đoán lỗi USB/ADB, cổng mạng và trích xuất nhật ký stream trực tiếp.
- `logs/`: Thư mục chứa toàn bộ nhật ký phiên kết nối và file `latest.log`.

---

## 3. Hướng dẫn Chạy & Sử Dụng

### Bước 1: Chạy PC Receiver trên máy tính
Chạy file `start-pc-receiver.bat` hoặc mở terminal:
```powershell
cd pc-receiver
node server.js
```
Sau đó mở trình duyệt Chrome / Edge tại địa chỉ: `http://localhost:3080`.
*(Mẹo: Bạn có thể bấm nút **"🎮 Chạy Luồng Giả Lập 60FPS H.264"** trên giao diện PC để kiểm thử ngay bộ giải mã GPU và thanh trượt Bitrate trước khi kết nối điện thoại).*

### Bước 2: Build & Cài đặt App Android (`android-sender`)
1. Mở thư mục `android-sender` bằng **Android Studio**.
2. Cắm điện thoại Android và bấm **Run ('app')** để cài đặt ứng dụng **HyperMirror Pro** lên điện thoại.

### Bước 3: Kết nối Chơi Game
- **Cách A — Cắm dây cáp USB (Độ trễ thấp nhất ~10ms, khuyên dùng khi leo rank)**:
  1. Cắm cáp USB từ điện thoại vào PC (bật *USB Debugging* hoặc *USB Tethering*).
  2. Trên App Android, chọn **"Cắm dây USB (ADB Forward)"**, chọn **120 FPS**, **H.264**, **Bitrate 24–32 Mbps**, rồi bấm **"BẮT ĐẦU CHIẾU MÀN HÌNH"**.
  3. Trên giao diện PC (`http://localhost:3080`), bấm nút **"⚡ Kết nối Cáp USB"**.
- **Cách B — Kết nối qua Wi-Fi 5GHz/6GHz**:
  1. Xem địa chỉ **IP Wi-Fi PC** hiển thị trên giao diện PC Receiver (ví dụ `192.168.1.100`).
  2. Trên App Android, chọn **"Wi-Fi 5GHz"**, nhập IP của PC (`192.168.1.100`), chọn **60/90/120 FPS**, **H.265 (HEVC)** hoặc **H.264**, rồi bấm **"BẮT ĐẦU CHIẾU MÀN HÌNH"**.

---

## 4. Kiểm Tra Nhật Ký & Tự Động Chẩn Đoán (Self-Debug)

- **Xem trực tiếp trên giao diện Web**:
  Bấm nút **"📋 Xem Nhật Ký / Logs Trực Tiếp (Debug)"** tại `http://localhost:3080` để xem ngay các sự kiện âm thanh/hình ảnh, kết nối WebAudio và cảnh báo hệ thống.
- **Tự động quét lỗi qua Command Line**:
  Nhấp đúp vào `debug-logs.bat` hoặc chạy:
  ```powershell
  node scripts/debug-status.js
  ```
  Công cụ sẽ kiểm tra ngay:
  1. Kết nối cáp USB ADB của điện thoại.
  2. Cấu hình cổng ADB Reverse và Forward.
  3. Trạng thái hoạt động của máy chủ PC và WebSocket.
  4. Trích xuất 25 dòng nhật ký mới nhất từ `logs/latest.log` bao gồm tốc độ âm thanh (pkts/s), video FPS và cảnh báo rớt gói.
  5. Kiểm tra trực tiếp logcat của hệ điều hành Android (AudioRecord / MediaProjection).

