# BÁO CÁO THỰC HÀNH LAB 3: KẾT NỐI VÀ DUY TRÌ KẾT NỐI GIỮA CÁC SERVICE
**Học phần:** Lập trình Web / Kiến trúc Hệ thống Phân tán  
**Giảng viên:** ThS Nguyễn Việt Dũng  
**Dự án:** Hệ thống thanh toán học phí (Fee Service) kết nối Cổng ngân hàng (Bank Service)

---

## 1. TỔNG QUAN KIẾN TRÚC HỆ THỐNG

```
    [ Sinh viên / Client ]
             │
             │ HTTP (cổng 4001)
             ▼
┌───────────────────────────────┐
│         FEE SERVICE           │
│  - GET /students/:id/fees     │  (Độc lập, non-blocking < 300ms)
│  - POST /students/:id/payments│
│    + Connection Pooling       │  (Tái sử dụng TCP socket, keepAlive: true)
│    + Circuit Timeout (4.0s)   │  (Ngắt chờ khi ngân hàng chậm, trả 504 PENDING)
│    + Idempotency Retry        │  (Gửi Idempotency-Key = paymentId, max 3 lần)
└──────────────┬────────────────┘
               │
               │ HTTP Keep-Alive (Agent Pool: maxSockets=20)
               ▼
┌───────────────────────────────┐
│     NGÂN HÀNG GIẢ LẬP         │
│  - POST /charges              │  (Hạn mức 20.000.000đ, Idempotent charge)
│  - GET /stats                 │  (connections, requests, charges, duplicates)
│  - Config: DELAY_MS,          │
│    FAIL_RATE, DROP_RATE       │
└───────────────────────────────┘
```

---

## 2. BẢNG TỔNG HỢP SỐ LIỆU TRƯỚC VÀ SAU KHI SỬA (DÙNG CHO THUYẾT TRÌNH)

| Tình huống | Chỉ số đo đạc | TRƯỚC KHI SỬA (Ban đầu / Mặc định) | SAU KHI SỬA (Đã tối ưu & Khắc phục) | Kết quả & Đánh giá |
| :--- | :--- | :--- | :--- | :--- |
| **Tình huống 1**<br>Ngân hàng tắt rồi bật lại | • HTTP Status khi Bank tắt<br>• Thời gian phản hồi<br>• Fee Service khi Bank tắt<br>• Gọi lại khi Bank bật | ❌ Trả 500 mơ hồ hoặc treo request<br>❌ Lâu (> 1.5s)<br>❌ Có nguy cơ crash unhandled rejection<br>❌ Phải restart lại Fee Service | ✅ **503 FAILED**<br>✅ **2 ms** (< 1.5s)<br>✅ **GET /fees vẫn 200 OK (< 5ms)**<br>✅ **Tự phục hồi 201 PAID ngay** | **ĐẠT CHUẨN 100%**<br>Fee Service sống bền bỉ, cô lập lỗi mạng |
| **Tình huống 2**<br>Ngân hàng chậm (DELAY=5000ms) | • Status thanh toán<br>• Thời gian phản hồi<br>• Độ trễ GET /fees khi nghẽn | ❌ Chờ vô hạn theo ngân hàng (> 5s)<br>❌ Treo kết nối khách hàng<br>❌ Có nguy cơ nghẽn I/O hệ thống | ✅ **504 PENDING**<br>✅ **4.012 ms** (≤ 4.5s)<br>✅ **GET /fees chỉ 4 ms** (< 300ms) | **ĐẠT CHUẨN 100%**<br>Không làm nghẽn Event Loop |
| **Tình huống 3**<br>Duy trì kết nối (200 payments, concurrency=10) | • Số kết nối TCP ngân hàng mở<br>• Tổng thời gian 200 calls<br>• Số payment thành công<br>• Sau nhàn rỗi 6 giây | ❌ **200 kết nối TCP** (mỗi request 1 TCP)<br>❌ **743 ms** (tốn chi phí TCP handshake)<br>⚠️ Tốn tài nguyên file descriptor<br>⚠️ Đứt socket cũ nếu không xử lý | ✅ **10 kết nối TCP** (≤ 20)<br>✅ **363 ms** (Nhanh hơn 51%)<br>✅ **200/200 thành công** (100%)<br>✅ **5/5 thành công sau 6s idle** | **ĐẠT CHUẨN 100%**<br>Tiết kiệm 95% kết nối TCP, tăng gấp đôi tốc độ |
| **Tình huống 4a**<br>Đứt mạng sau khi trừ tiền (DROP_RATE=0.3) | • Tỉ lệ thành công (60 calls)<br>• Số tiền trừ trùng (duplicates)<br>• Công nợ sinh viên | ❌ Chỉ ~42/60 thành công (~70%)<br>❌ Nếu retry ngây thơ: duplicates > 0<br>❌ Sai lệch công nợ thực tế | ✅ **60/60 thành công** (≥ 54/60)<br>✅ **duplicates = 0**<br>✅ **Công nợ giảm chuẩn xác 100%** | **ĐẠT CHUẨN 100%**<br>Idempotent Retry giải quyết triệt để duplicate |
| **Tình huống 4b**<br>Lỗi 500 tạm thời (FAIL_RATE=0.3) | • Tỉ lệ thành công (60 calls)<br>• Số lần trừ tiền trùng | ❌ Chỉ ~42/60 thành công (rớt 30%)<br>❌ Người dùng phải tự bấm lại | ✅ **58/60 thành công** (≥ 54/60)<br>✅ **duplicates = 0** | **ĐẠT CHUẨN 100%**<br>Tự động khắc phục lỗi thoáng qua |
| **Tình huống 4c**<br>Từ chối vượt hạn mức (Thanh toán 25.000.000đ) | • HTTP Status trả về<br>• Số request gửi tới Bank | ❌ 500 hoặc retry sai lầm nhiều lần<br>❌ Làm nghẽn gateway ngân hàng | ✅ **402 FAILED**<br>✅ **Bank nhận đúng 1 request** (No retry) | **ĐẠT CHUẨN 100%**<br>Phân biệt chính xác lỗi 4xx và 5xx |

---

## 3. CHI TIẾT CÁC GIẢI PHÁP ĐÃ ÁP DỤNG

### 3.1. Phân loại lỗi mạng và Mã HTTP (Error Taxonomy)
Tuân thủ chặt chẽ bảng quy ước kết quả thanh toán:
- **Thành công (201 PAID):** Ngân hàng xác nhận đã trừ tiền -> Giảm công nợ sinh viên `student.debt -= amount`.
- **Ngân hàng từ chối rõ ràng (402 FAILED, 400 FAILED):** Giữ nguyên mã của ngân hàng. **Không thử lại (NO RETRY)** để tránh spam tài nguyên ngân hàng khi yêu cầu chắc chắn không hợp lệ.
- **Chắc chắn chưa trừ tiền (503 FAILED):** Lỗi `ECONNREFUSED` / không thể kết nối tới ngân hàng. Phản hồi lập tức (< 1.5s), không làm sập server.
- **Không biết đã trừ tiền hay chưa (504 PENDING):** Hết thời gian chờ (ETIMEDOUT > 4s) hoặc đứt kết nối khi đang chờ phản hồi. Trả về trạng thái `PENDING` để nhân viên/sinh viên tra soát sau.

### 3.2. HTTP Connection Pooling & Keep-Alive (Tình huống 3)
- Sử dụng `http.Agent`:
  ```javascript
  const bankAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 20,
    maxFreeSockets: 10,
    keepAliveMsecs: 10000,
    timeout: 4000
  });
  ```
- **Lợi ích:** 
  - Thay vì 200 lần bắt tay 3 bước TCP (SYN, SYN-ACK, ACK) và đóng kết nối (FIN), 200 request tái sử dụng chỉ **10 TCP sockets** từ pool.
  - Tốc độ xử lý nhanh hơn 51% (từ 743ms giảm xuống 363ms).
  - Tự động bắt sự kiện đóng kết nối nhàn rỗi từ phía ngân hàng (idle 5s) và tái tạo socket mới mượt mà.

### 3.3. Idempotent Retry với Idempotency-Key (Tình huống 4)
- **Vấn đề:** Khi `DROP_RATE=0.3`, ngân hàng đã trừ tiền thành công nhưng socket bị đứt trước khi kịp gửi phản hồi. Nếu Fee Service không retry, tỉ lệ thành công chỉ đạt 70%. Nếu Fee Service retry bình thường, ngân hàng sẽ trừ tiền lần 2 (`duplicates > 0`).
- **Giải pháp:** 
  - Fee Service gán mã định danh duy nhất `paymentId` (`P1, P2,...`) vào header `Idempotency-Key` và trường `reference`.
  - Khi gặp lỗi đứt kết nối (`ECONNRESET`, `socket hang up`) hoặc lỗi 500, Fee Service tự động retry tối đa 3 lần với **cùng một Idempotency-Key**.
  - Phía Ngân hàng lưu vết `idempotencyStore`. Khi nhận lại khóa đã xử lý, ngân hàng trả lại giao dịch cũ ngay lập tức mà không trừ tiền lần thứ hai (`duplicates = 0`).
  - Nhờ vậy, tỉ lệ thành công đạt **100% (60/60)** với `DROP_RATE=0.3` và **96.7% (58/60)** với `FAIL_RATE=0.3`.

---

## 4. HƯỚNG DẪN CÀI ĐẶT & CHẠY THỰC NGHIỆM

```bash
cd lab3-ket-noi-service
npm install
npm run test:all
```
