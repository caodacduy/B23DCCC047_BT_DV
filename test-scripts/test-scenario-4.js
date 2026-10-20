/**
 * TÌNH HUỐNG 4 — Đứt giữa chừng, lỗi tạm thời, bị từ chối
 * 
 * Bối cảnh:
 * (a) Ngân hàng đã trừ tiền rồi đứt kết nối trước khi trả lời (DROP_RATE=0.3).
 * (b) Ngân hàng trả lỗi 500 tạm thời trước khi trừ tiền (FAIL_RATE=0.3).
 * (c) Ngân hàng từ chối vì vượt hạn mức (thanh toán 25.000.000đ).
 * 
 * Kết quả cần đạt:
 * - (a): duplicates = 0; >= 54/60 thanh toán thành công; thanh toán không thành công trả 504 + PENDING;
 *        công nợ chỉ giảm đúng tiền của các lệnh PAID.
 * - (b): >= 54/60 thanh toán thành công; không trừ tiền hai lần.
 * - (c): trả 402, và ngân hàng chỉ nhận đúng 1 yêu cầu (không thử lại lỗi bị từ chối).
 * - Vẫn giữ giới hạn <= 4,5 giây của tình huống 2.
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

async function runScenario4() {
  console.log('================================================================');
  console.log('🧪 BẮT ĐẦU TEST TÌNH HUỐNG 4: Đứt kết nối, Lỗi 500 & Từ chối 402');
  console.log('================================================================\n');

  // PHẦN (A): DROP_RATE = 0.3
  console.log('--- [Phần 4a] Test DROP_RATE = 0.3 (Trừ tiền rồi đứt kết nối) ---');
  await request(`${BANK_URL}/stats/reset`, { method: 'POST' });
  await request(`${FEE_URL}/students/reset`, { method: 'POST' });
  await request(`${BANK_URL}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { DELAY_MS: 0, FAIL_RATE: 0, DROP_RATE: 0.3 });

  const initialDebt = (await request(`${FEE_URL}/students/1/fees`)).data.debt;

  console.log('Gửi 60 thanh toán lần lượt (100.000đ mỗi lần)...');
  const resultsA = [];
  for (let i = 0; i < 60; i++) {
    const res = await request(`${FEE_URL}/students/1/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { amount: 100000 });
    resultsA.push(res);
  }

  const paidA = resultsA.filter(r => r.statusCode === 201 && r.data.status === 'PAID').length;
  const statsA = (await request(`${BANK_URL}/stats`)).data;
  const currentDebtA = (await request(`${FEE_URL}/students/1/fees`)).data.debt;
  const expectedDebtA = initialDebt - (paidA * 100000);
  const isDebtAccurate = currentDebtA === expectedDebtA;

  console.log(`- Thành công (PAID): ${paidA}/60 (Kỳ vọng >= 54)`);
  console.log(`- Số lần trừ tiền trùng (duplicates): ${statsA.duplicates} (Kỳ vọng = 0)`);
  console.log(`- Công nợ giảm đúng: ${isDebtAccurate ? '✅ ĐÚNG' : '❌ SAI'}`);

  const checkA_dup = statsA.duplicates === 0;
  const checkA_rate = paidA >= 54;
  const checkA_debt = isDebtAccurate;

  // PHẦN (B): FAIL_RATE = 0.3
  console.log('\n--- [Phần 4b] Test FAIL_RATE = 0.3 (Lỗi 500 trước khi trừ tiền) ---');
  await request(`${BANK_URL}/stats/reset`, { method: 'POST' });
  await request(`${BANK_URL}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { DELAY_MS: 0, FAIL_RATE: 0.3, DROP_RATE: 0 });

  const resultsB = [];
  for (let i = 0; i < 60; i++) {
    const res = await request(`${FEE_URL}/students/1/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { amount: 100000 });
    resultsB.push(res);
  }

  const paidB = resultsB.filter(r => r.statusCode === 201 && r.data.status === 'PAID').length;
  const statsB = (await request(`${BANK_URL}/stats`)).data;

  console.log(`- Thành công (PAID): ${paidB}/60 (Kỳ vọng >= 54)`);
  console.log(`- Số lần trừ tiền trùng (duplicates): ${statsB.duplicates} (Kỳ vọng = 0)`);

  const checkB_dup = statsB.duplicates === 0;
  const checkB_rate = paidB >= 54;

  // PHẦN (C): VƯỢT HẠN MỨC (25.000.000đ)
  console.log('\n--- [Phần 4c] Test Thanh toán 25.000.000đ (Vượt hạn mức 20.000.000đ) ---');
  await request(`${BANK_URL}/stats/reset`, { method: 'POST' });
  await request(`${BANK_URL}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { DELAY_MS: 0, FAIL_RATE: 0, DROP_RATE: 0 });

  const resC = await request(`${FEE_URL}/students/1/payments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { amount: 25000000 });

  const statsC = (await request(`${BANK_URL}/stats`)).data;
  console.log(`- Mã HTTP trả về: ${resC.statusCode} (Kỳ vọng: 402)`);
  console.log(`- Số request ngân hàng nhận: ${statsC.requests} (Kỳ vọng: đúng 1 yêu cầu)`);

  const checkC_status = resC.statusCode === 402;
  const checkC_single = statsC.requests === 1;

  const passed = checkA_dup && checkA_rate && checkA_debt && checkB_dup && checkB_rate && checkC_status && checkC_single;
  console.log('\n================================================================');
  console.log(`KẾT QUẢ TÌNH HUỐNG 4: ${passed ? '🎉 HOÀN TOÀN ĐẠT CHUẨN' : '⚠️ CẦN KIỂM TRA LẠI'}`);
  console.log('================================================================\n');

  return { passed, paidA, paidB, duplicatesA: statsA.duplicates, duplicatesB: statsB.duplicates, statusC: resC.statusCode, requestsC: statsC.requests };
}

if (require.main === module) runScenario4();
module.exports = runScenario4;
