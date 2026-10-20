const express = require('express');
const http = require('http');

const app = express();
app.use(express.json());

// 1. Cấu hình hành vi lỗi từ biến môi trường (khởi động lại để áp dụng)
let DELAY_MS = parseInt(process.env.DELAY_MS || '0', 10);
let FAIL_RATE = parseFloat(process.env.FAIL_RATE || '0');
let DROP_RATE = parseFloat(process.env.DROP_RATE || '0');
const PORT = parseInt(process.env.PORT || '4002', 10);

// 2. Metrics theo dõi theo đề bài
let connections = 0; // Số kết nối TCP mới nhận
let requests = 0;    // Tổng số yêu cầu nhận được
let charges = 0;     // Số lần trừ tiền thực tế
let duplicates = 0;  // Số lần trừ tiền trùng cho cùng một reference (phải luôn = 0)

// In-Memory Database
const idempotencyStore = new Map(); // Idempotency-Key -> chargeRecord
const chargedReferences = new Set(); // reference -> boolean

const server = http.createServer(app);

// 3. Giữ kết nối nhàn rỗi tối đa 5 giây (mặc định Node.js)
server.keepAliveTimeout = 5000;
server.headersTimeout = 6000;

// In log mỗi khi có kết nối TCP mới
server.on('connection', (socket) => {
  connections++;
  console.log(`[BANK] ⚡ New TCP connection #${connections} accepted from ${socket.remoteAddress}:${socket.remotePort}`);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// GET /stats -> {connections, requests, charges, duplicates}
app.get('/stats', (req, res) => {
  res.json({
    connections,
    requests,
    charges,
    duplicates,
    config: {
      DELAY_MS,
      FAIL_RATE,
      DROP_RATE
    }
  });
});

// Endpoint hỗ trợ reset số liệu giữa các kịch bản test
app.post('/stats/reset', (req, res) => {
  connections = 0;
  requests = 0;
  charges = 0;
  duplicates = 0;
  idempotencyStore.clear();
  chargedReferences.clear();
  console.log('[BANK] Đã reset stats và idempotency store.');
  res.json({ message: 'Stats reset successfully', stats: { connections, requests, charges, duplicates } });
});

// Endpoint cho phép cập nhật cấu hình test linh hoạt nếu không muốn restart
app.post('/config', (req, res) => {
  if (req.body.DELAY_MS !== undefined) DELAY_MS = parseInt(req.body.DELAY_MS, 10);
  if (req.body.FAIL_RATE !== undefined) FAIL_RATE = parseFloat(req.body.FAIL_RATE);
  if (req.body.DROP_RATE !== undefined) DROP_RATE = parseFloat(req.body.DROP_RATE);
  console.log(`[BANK] Config updated: DELAY_MS=${DELAY_MS}, FAIL_RATE=${FAIL_RATE}, DROP_RATE=${DROP_RATE}`);
  res.json({ DELAY_MS, FAIL_RATE, DROP_RATE });
});

// POST /charges {"reference", "amount"}
app.post('/charges', async (req, res) => {
  requests++;
  const { reference, amount } = req.body || {};
  const idempotencyKey = req.headers['idempotency-key'] || (reference ? `ref-${reference}` : null);

  // 1. Trễ thêm ngần ấy ms nếu DELAY_MS được cấu hình
  if (DELAY_MS > 0) {
    await sleep(DELAY_MS);
  }

  // 2. 400 nếu số tiền không hợp lệ hoặc thiếu reference
  if (!reference || typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({
      error: 'Số tiền hoặc mã tham chiếu không hợp lệ',
      status: 'FAILED'
    });
  }

  // 3. 402 nếu vượt hạn mức 20.000.000đ
  if (amount > 20000000) {
    console.log(`[BANK] ⚠️ Amount ${amount} vượt hạn mức 20.000.000đ. Trả về 402.`);
    return res.status(402).json({
      error: 'Số tiền vượt hạn mức giao dịch 20.000.000đ',
      status: 'FAILED'
    });
  }

  // 4. Header Idempotency-Key: gửi lại cùng một khóa thì trả lại giao dịch cũ, không trừ thêm
  if (idempotencyKey && idempotencyStore.has(idempotencyKey)) {
    const existing = idempotencyStore.get(idempotencyKey);
    console.log(`[BANK] 🔁 Trùng Idempotency-Key: ${idempotencyKey}. Trả lại kết quả cũ chargeId: ${existing.chargeId}`);
    return res.status(201).json(existing);
  }

  // 5. FAIL_RATE (0–1): tỉ lệ trả lỗi 500 trước khi trừ tiền
  if (FAIL_RATE > 0 && Math.random() < FAIL_RATE) {
    console.log(`[BANK] ❌ Simulating FAIL_RATE (${FAIL_RATE}). Trả về 500 trước khi trừ tiền.`);
    return res.status(500).json({
      error: 'Lỗi hệ thống nội bộ ngân hàng (Internal Server Error)',
      status: 'FAILED'
    });
  }

  // 6. Thực hiện trừ tiền
  if (chargedReferences.has(reference)) {
    duplicates++;
    console.error(`[BANK ERROR] 🚨 Phát hiện trừ tiền trùng cho reference: ${reference}! duplicates = ${duplicates}`);
  } else {
    chargedReferences.add(reference);
  }
  charges++;

  const chargeId = `CHG_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const chargeRecord = {
    chargeId,
    reference,
    amount,
    status: 'PAID'
  };

  if (idempotencyKey) {
    idempotencyStore.set(idempotencyKey, chargeRecord);
  }

  // 7. DROP_RATE (0–1): tỉ lệ trừ tiền xong rồi cắt kết nối trước khi trả lời
  if (DROP_RATE > 0 && Math.random() < DROP_RATE) {
    console.log(`[BANK] 💥 Simulating DROP_RATE (${DROP_RATE}). Đã trừ tiền, cắt socket ngay lập tức.`);
    if (req.socket && !req.socket.destroyed) {
      req.socket.destroy();
    }
    return;
  }

  // 8. Thành công: 201 kèm chargeId
  return res.status(201).json(chargeRecord);
});

// Khởi động server
server.listen(PORT, () => {
  console.log(`[BANK SERVICE] 🏦 Cổng ngân hàng giả lập đang chạy tại http://localhost:${PORT}`);
  console.log(`[BANK SERVICE] Cấu hình: DELAY_MS=${DELAY_MS}, FAIL_RATE=${FAIL_RATE}, DROP_RATE=${DROP_RATE}`);
  console.log(`[BANK SERVICE] Keep-Alive Timeout: 5000ms`);
});
