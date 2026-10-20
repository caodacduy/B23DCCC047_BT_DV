/**
 * TÌNH HUỐNG 2 — Ngân hàng phản hồi rất chậm
 * 
 * Bối cảnh: Giờ cao điểm đóng học phí, ngân hàng quá tải, mỗi giao dịch 5 giây mới trả lời.
 * Kết quả cần đạt:
 * - Thanh toán trả 504 với status: "PENDING" thay vì chờ ngân hàng.
 * - Tổng thời gian trả lời <= 4,5 giây.
 * - Khi 20 thanh toán đang chờ, GET /students/1/fees vẫn phản hồi < 300ms.
 */

const http = require('http');

const FEE_URL = 'http://localhost:4001';
const BANK_URL = 'http://localhost:4002';

function request(url, options = {}, body = null) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const reqOptions = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    const startTime = Date.now();
    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const duration = Date.now() - startTime;
        let json = null;
        try { json = JSON.parse(data); } catch { json = data; }
        resolve({ statusCode: res.statusCode, data: json, duration });
      });
    });

    req.on('error', (err) => {
      const duration = Date.now() - startTime;
      resolve({ statusCode: 0, error: err.message, duration });
    });

    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function runScenario2() {
  console.log('================================================================');
  console.log('🧪 BẮT ĐẦU TEST TÌNH HUỐNG 2: Ngân hàng phản hồi rất chậm (DELAY_MS=5000)');
  console.log('================================================================\n');

  await request(`${BANK_URL}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { DELAY_MS: 5000, FAIL_RATE: 0, DROP_RATE: 0 });

  // 1. Gọi 1 thanh toán đơn lẻ
  console.log('--- [Bước 1] Đo 1 thanh toán để kiểm tra Circuit Timeout ---');
  const singlePay = await request(`${FEE_URL}/students/1/payments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { amount: 100000 });

  console.log(`⏱️ Thời gian phản hồi: ${singlePay.duration} ms`);
  console.log(`📥 HTTP Status: ${singlePay.statusCode}`);
  console.log('📦 Response Body:', JSON.stringify(singlePay.data, null, 2));

  const check1_status = singlePay.statusCode === 504;
  const check1_pending = singlePay.data && singlePay.data.status === 'PENDING';
  const check1_time = singlePay.duration <= 4500;

  console.log(`- Trả về mã 504: ${check1_status ? '✅ ĐẠT' : '❌ CHƯA ĐẠT'}`);
  console.log(`- Status là PENDING: ${check1_pending ? '✅ ĐẠT' : '❌ CHƯA ĐẠT'}`);
  console.log(`- Thời gian <= 4.5s (${singlePay.duration}ms): ${check1_time ? '✅ ĐẠT' : '❌ CHƯA ĐẠT'}`);

  // 2. Bắn cùng lúc 20 thanh toán và trong lúc đó gọi GET /fees
  console.log('\n--- [Bước 2] Bắn cùng lúc 20 thanh toán & kiểm tra độ trễ GET /fees ---');
  const paymentPromises = Array.from({ length: 20 }, () => {
    return request(`${FEE_URL}/students/1/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { amount: 1000 });
  });

  await sleep(400);

  const feeWhileWaiting = await request(`${FEE_URL}/students/1/fees`);
  console.log(`⏱️ Thời gian phản hồi GET /fees khi hệ thống đang nghẽn: ${feeWhileWaiting.duration} ms (Yêu cầu < 300ms)`);
  const check2_feeFast = feeWhileWaiting.statusCode === 200 && feeWhileWaiting.duration < 300;
  console.log(`- GET /fees phản hồi < 300ms: ${check2_feeFast ? '✅ ĐẠT' : '❌ CHƯA ĐẠT'}`);

  const results = await Promise.all(paymentPromises);
  const all504 = results.every(r => r.statusCode === 504 && r.data.status === 'PENDING');
  const allUnder4500 = results.every(r => r.duration <= 4500);

  console.log(`- 20/20 thanh toán trả về 504 PENDING: ${all504 ? '✅ ĐẠT' : '❌ CHƯA ĐẠT'}`);
  console.log(`- Tất cả 20 thanh toán đều <= 4.5s: ${allUnder4500 ? '✅ ĐẠT' : '❌ CHƯA ĐẠT'}`);

  await request(`${BANK_URL}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { DELAY_MS: 0 });

  const passed = check1_status && check1_pending && check1_time && check2_feeFast && all504 && allUnder4500;
  console.log('\n================================================================');
  console.log(`KẾT QUẢ TÌNH HUỐNG 2: ${passed ? '🎉 HOÀN TOÀN ĐẠT CHUẨN' : '⚠️ CẦN KIỂM TRA LẠI'}`);
  console.log('================================================================\n');

  return { passed, singlePay, feeWhileWaiting, all504, allUnder4500 };
}

if (require.main === module) runScenario2();
module.exports = runScenario2;
