const express = require('express');
const http = require('http');

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.PORT || '4001', 10);
const BANK_URL = process.env.BANK_URL || 'http://localhost:4002';
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || '4000', 10);
const KEEP_ALIVE = process.env.KEEP_ALIVE !== 'false';
const RETRY_ENABLED = process.env.RETRY_ENABLED !== 'false';

// Dữ liệu trong bộ nhớ:
// Sinh viên 1 nợ 50.000.000đ; 2 nợ 0đ; 3 nợ 3.200.000đ
const students = {
  1: { id: 1, name: 'Sinh vien 1', debt: 50000000 },
  2: { id: 2, name: 'Sinh vien 2', debt: 0 },
  3: { id: 3, name: 'Sinh vien 3', debt: 3200000 }
};

let paymentCounter = 0;

// HTTP Agent duy trì kết nối (Connection Pooling / Keep-Alive)
const bankAgent = new http.Agent({
  keepAlive: KEEP_ALIVE,
  maxSockets: 20,
  maxFreeSockets: 10,
  keepAliveMsecs: 10000,
  timeout: TIMEOUT_MS
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// GET /students/{id}/fees: Tra cứu công nợ sinh viên (hoàn toàn độc lập, nhanh < 300ms)
app.get('/students/:id/fees', (req, res) => {
  const studentId = parseInt(req.params.id, 10);
  const student = students[studentId];

  if (!student) {
    return res.status(404).json({
      error: 'Không tìm thấy sinh viên',
      status: 'FAILED'
    });
  }

  return res.status(200).json({
    studentId: student.id,
    name: student.name,
    debt: student.debt
  });
});

// Helper: Gọi Cổng Ngân hàng qua HTTP request với Agent & Timeout
function executeBankRequest(paymentId, amount, timeoutMs, disableKeepAlive = false) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${BANK_URL}/charges`);
    const postData = JSON.stringify({ reference: paymentId, amount });
    const useKeepAlive = KEEP_ALIVE && !disableKeepAlive;

    const options = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      agent: useKeepAlive ? bankAgent : false,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'Idempotency-Key': paymentId,
        'Connection': useKeepAlive ? 'keep-alive' : 'close'
      },
      timeout: timeoutMs
    };

    const req = http.request(options, (bankRes) => {
      let bodyData = '';
      bankRes.on('data', (chunk) => { bodyData += chunk; });
      bankRes.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(bodyData);
        } catch {
          json = { raw: bodyData };
        }
        resolve({
          statusCode: bankRes.statusCode,
          data: json
        });
      });
    });

    let isTimedOut = false;
    req.on('timeout', () => {
      isTimedOut = true;
      req.destroy(new Error('ETIMEDOUT'));
    });

    req.on('error', (err) => {
      if (isTimedOut || err.message === 'ETIMEDOUT') {
        const timeoutErr = new Error('TIMEOUT');
        timeoutErr.code = 'ETIMEDOUT';
        reject(timeoutErr);
      } else {
        reject(err);
      }
    });

    req.write(postData);
    req.end();
  });
}

// POST /students/{id}/payments {"amount": 100000}
app.post('/students/:id/payments', async (req, res) => {
  const studentId = parseInt(req.params.id, 10);
  const student = students[studentId];
  const { amount } = req.body || {};

  // 1. Kiểm tra sinh viên
  if (!student) {
    return res.status(404).json({
      error: 'Không tìm thấy sinh viên',
      paymentId: null,
      status: 'FAILED'
    });
  }

  // 2. Kiểm tra số tiền hợp lệ
  if (typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({
      error: 'Số tiền thanh toán không hợp lệ',
      paymentId: null,
      status: 'FAILED'
    });
  }

  // 3. Kiểm tra số tiền không vượt công nợ
  if (amount > student.debt) {
    return res.status(400).json({
      error: `Số tiền thanh toán (${amount}đ) vượt quá công nợ hiện tại (${student.debt}đ)`,
      paymentId: null,
      status: 'FAILED'
    });
  }

  // 4. Tạo lệnh P1, P2...
  paymentCounter++;
  const paymentId = `P${paymentCounter}`;

  const disableKeepAlive = req.headers['x-disable-keep-alive'] === 'true' || req.query.no_keep_alive === '1';
  const disableRetry = req.headers['x-disable-retry'] === 'true' || req.query.no_retry === '1';

  // 5. Gọi ngân hàng, xử lý các tình huống lỗi và retry có Idempotency-Key
  const maxAttempts = (RETRY_ENABLED && !disableRetry) ? 3 : 1;
  let attempt = 0;
  let lastError = null;
  let lastResponse = null;

  const startTime = Date.now();

  while (attempt < maxAttempts) {
    attempt++;
    const remainingTime = Math.max(1000, (startTime + TIMEOUT_MS) - Date.now());

    try {
      lastResponse = await executeBankRequest(paymentId, amount, remainingTime, disableKeepAlive);

      // (a) Thành công (201): Ngân hàng xác nhận đã trừ tiền -> Giảm công nợ
      if (lastResponse.statusCode === 201) {
        student.debt -= amount;
        return res.status(201).json({
          paymentId,
          status: 'PAID',
          chargeId: lastResponse.data.chargeId,
          amount,
          remainingDebt: student.debt
        });
      }

      // (b) Ngân hàng từ chối rõ ràng (4xx): Giữ mã của ngân hàng (ví dụ 402), FAILED, KHÔNG THỬ LẠI
      if (lastResponse.statusCode >= 400 && lastResponse.statusCode < 500) {
        return res.status(lastResponse.statusCode).json({
          error: lastResponse.data.error || 'Ngân hàng từ chối giao dịch',
          paymentId,
          status: 'FAILED'
        });
      }

      // (c) Ngân hàng trả lỗi 500 tạm thời trước khi trừ tiền (FAIL_RATE):
      // Thử lại với cùng Idempotency-Key
      if (lastResponse.statusCode >= 500) {
        if (attempt < maxAttempts) {
          console.log(`[FEE SERVICE] Ngân hàng trả 500 cho ${paymentId}. Tự động thử lại lần ${attempt + 1}/${maxAttempts}...`);
          await sleep(50);
          continue;
        } else {
          // Chắc chắn chưa trừ tiền
          return res.status(503).json({
            error: 'Ngân hàng gặp sự cố tạm thời sau các lần thử lại',
            paymentId,
            status: 'FAILED'
          });
        }
      }

    } catch (err) {
      lastError = err;
      const errorCode = err.code || err.message;

      // (d) Chắc chắn chưa trừ tiền (503 FAILED): Không kết nối được tới ngân hàng
      if (errorCode === 'ECONNREFUSED' || errorCode === 'ENOTFOUND' || errorCode === 'EHOSTUNREACH') {
        return res.status(503).json({
          error: 'Không kết nối được tới ngân hàng',
          paymentId,
          status: 'FAILED'
        });
      }

      // (e) Hết thời gian chờ (504 PENDING): Không biết đã trừ tiền hay chưa
      if (errorCode === 'ETIMEDOUT' || err.message === 'TIMEOUT') {
        return res.status(504).json({
          error: 'Hết thời gian chờ phản hồi từ ngân hàng',
          paymentId,
          status: 'PENDING'
        });
      }

      // (f) Đứt kết nối khi đang chờ trả lời (DROP_RATE: ECONNRESET, socket hang up)
      // Thử lại với cùng Idempotency-Key
      if (attempt < maxAttempts && (errorCode === 'ECONNRESET' || errorCode === 'EPIPE' || err.message.includes('hang up') || err.message.includes('premature'))) {
        console.log(`[FEE SERVICE] Đứt kết nối cho ${paymentId} (${errorCode}). Thử lại với Idempotency-Key lần ${attempt + 1}/${maxAttempts}...`);
        await sleep(50);
        continue;
      }

      // Đã thử hết số lần hoặc đứt kết nối không thể khắc phục: Không biết đã trừ tiền hay chưa (504 PENDING)
      return res.status(504).json({
        error: 'Đứt kết nối khi đang chờ trả lời từ ngân hàng',
        paymentId,
        status: 'PENDING'
      });
    }
  }

  return res.status(504).json({
    error: 'Không xác định được trạng thái giao dịch',
    paymentId,
    status: 'PENDING'
  });
});

// Helper reset công nợ cho bài test
app.post('/students/reset', (req, res) => {
  students[1].debt = 50000000;
  students[2].debt = 0;
  students[3].debt = 3200000;
  paymentCounter = 0;
  res.json({ message: 'Đã reset công nợ sinh viên', students });
});

// Khởi động server
app.listen(PORT, () => {
  console.log(`[FEE SERVICE] 🎓 Fee Service đang chạy tại http://localhost:${PORT}`);
  console.log(`[FEE SERVICE] BANK_URL=${BANK_URL}, TIMEOUT_MS=${TIMEOUT_MS}, KEEP_ALIVE=${KEEP_ALIVE}`);
});
