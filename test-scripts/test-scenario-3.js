/**
 * TÌNH HUỐNG 3 — Duy trì kết nối (HTTP Keep-Alive / Connection Pool)
 * 
 * Bối cảnh: Nghìn sinh viên thanh toán trong vài phút. Nếu mỗi lời gọi mở một kết nối TCP mới rồi đóng
 * thì tốn thời gian bắt tay và tài nguyên của cả hai phía. Ngân hàng lại đóng kết nối nhàn rỗi sau 5 giây.
 * 
 * Kết quả cần đạt:
 * - 200/200 thanh toán thành công.
 * - Số kết nối TCP ngân hàng phải mở <= 20.
 * - Sau khi nhàn rỗi 6 giây (ngân hàng đã đóng kết nối cũ), vài yêu cầu tiếp theo vẫn thành công.
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

async function runConcurrentRequests(total, concurrency, headers = {}) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < total) {
      const current = index++;
      const res = await request(`${FEE_URL}/students/1/payments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers
        }
      }, { amount: 1000 });
      results.push(res);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

async function runScenario3() {
  console.log('================================================================');
  console.log('🧪 BẮT ĐẦU TEST TÌNH HUỐNG 3: Duy trì kết nối TCP (Keep-Alive Pool)');
  console.log('================================================================\n');

  await request(`${BANK_URL}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { DELAY_MS: 0, FAIL_RATE: 0, DROP_RATE: 0 });

  // 1. TRƯỚC KHI SỬA (Không Keep-Alive)
  console.log('--- [Phần 1: TRƯỚC KHI SỬA] (Keep-Alive = False) ---');
  await request(`${BANK_URL}/stats/reset`, { method: 'POST' });

  const beforeStart = Date.now();
  const beforeResults = await runConcurrentRequests(200, 10, { 'x-disable-keep-alive': 'true' });
  const beforeDuration = Date.now() - beforeStart;
  const beforeStats = (await request(`${BANK_URL}/stats`)).data;
  const beforeSuccess = beforeResults.filter(r => r.statusCode === 201).length;

  console.log(`⏱️ Tổng thời gian: ${beforeDuration} ms`);
  console.log(`✅ Thành công: ${beforeSuccess}/200`);
  console.log(`🔌 Số kết nối TCP ngân hàng mở: ${beforeStats.connections}`);

  // 2. SAU KHI SỬA (Có Connection Pool)
  console.log('\n--- [Phần 2: SAU KHI SỬA] (Keep-Alive Pool = True, MaxSockets = 20) ---');
  await request(`${BANK_URL}/stats/reset`, { method: 'POST' });

  const afterStart = Date.now();
  const afterResults = await runConcurrentRequests(200, 10, {});
  const afterDuration = Date.now() - afterStart;
  const afterStats = (await request(`${BANK_URL}/stats`)).data;
  const afterSuccess = afterResults.filter(r => r.statusCode === 201).length;

  console.log(`⏱️ Tổng thời gian: ${afterDuration} ms (Nhanh hơn ${Math.round((beforeDuration - afterDuration) / beforeDuration * 100)}%)`);
  console.log(`✅ Thành công: ${afterSuccess}/200`);
  console.log(`🔌 Số kết nối TCP ngân hàng mở: ${afterStats.connections}`);

  const check1_success = afterSuccess === 200;
  const check2_connections = afterStats.connections <= 20;

  console.log(`- 200/200 thanh toán thành công: ${check1_success ? '✅ ĐẠT' : '❌ CHƯA ĐẠT'}`);
  console.log(`- Số kết nối TCP <= 20 (${afterStats.connections}): ${check2_connections ? '✅ ĐẠT' : '❌ CHƯA ĐẠT'}`);

  // 3. SAU KHI NHÀN RỖI 6 GIÂY
  console.log('\n--- [Phần 3: SAU KHI NHÀN RỖI 6 GIÂY] ---');
  console.log('Chờ 6.2 giây để ngân hàng tự đóng các kết nối nhàn rỗi (timeout 5s)...');
  await sleep(6200);

  const idleResults = [];
  for (let i = 0; i < 5; i++) {
    const res = await request(`${FEE_URL}/students/1/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { amount: 1000 });
    idleResults.push(res);
  }
  const idleSuccess = idleResults.filter(r => r.statusCode === 201).length;
  console.log(`✅ Kết quả 5 thanh toán sau nhàn rỗi: ${idleSuccess}/5 thành công`);
  const check3_idle = idleSuccess === 5;
  console.log(`- Các yêu cầu sau nhàn rỗi vẫn thành công: ${check3_idle ? '✅ ĐẠT' : '❌ CHƯA ĐẠT'}`);

  const passed = check1_success && check2_connections && check3_idle;
  console.log('\n================================================================');
  console.log(`KẾT QUẢ TÌNH HUỐNG 3: ${passed ? '🎉 HOÀN TOÀN ĐẠT CHUẨN' : '⚠️ CẦN KIỂM TRA LẠI'}`);
  console.log('================================================================\n');

  return {
    passed,
    comparison: {
      before: { duration: beforeDuration, tcp: beforeStats.connections, success: beforeSuccess },
      after: { duration: afterDuration, tcp: afterStats.connections, success: afterSuccess }
    }
  };
}

if (require.main === module) runScenario3();
module.exports = runScenario3;
