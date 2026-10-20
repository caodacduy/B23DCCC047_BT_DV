/**
 * TÌNH HUỐNG 1 — Ngân hàng không kết nối được, rồi hoạt động lại
 * 
 * Bối cảnh: Sáng thứ Hai đội hạ tầng khởi động lại cụm máy chủ: Fee Service lên trước,
 * ngân hàng lên sau vài phút. Sinh viên vẫn bấm thanh toán trong lúc đó.
 * 
 * Kết quả cần đạt:
 * - Khi ngân hàng tắt: thanh toán trả 503, JSON có error, trong < 1,5 giây.
 * - Fee Service không sập; GET /students/1/fees vẫn trả 200 nhanh.
 * - Khi ngân hàng chạy lại: thanh toán trả 201 mà không cần khởi động lại Fee Service.
 * - Địa chỉ ngân hàng lấy từ biến môi trường BANK_URL (mặc định http://localhost:4002);
 *   đổi sang http://localhost:4999 thì hành vi vẫn giống.
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

async function runScenario1() {
  console.log('================================================================');
  console.log('🧪 BẮT ĐẦU TEST TÌNH HUỐNG 1: Ngân hàng tắt -> Bật lại');
  console.log('================================================================\n');

  // Bước 1: Khi ngân hàng tắt
  console.log('--- [Bước 1] Khi ngân hàng CHƯA chạy ---');
  console.log('Gửi POST /students/1/payments {"amount": 100000} sang Fee Service...');
  const payDown = await request(`${FEE_URL}/students/1/payments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { amount: 100000 });

  console.log(`⏱️ Thời gian phản hồi: ${payDown.duration} ms`);
  console.log(`📥 HTTP Status: ${payDown.statusCode}`);
  console.log('📦 Response Body:', JSON.stringify(payDown.data, null, 2));

  const check1_status = payDown.statusCode === 503;
  const check1_time = payDown.duration < 1500;
  const check1_body = payDown.data && payDown.data.status === 'FAILED' && payDown.data.error;

  console.log(`- Trả về mã 503: ${check1_status ? '✅ ĐẠT' : '❌ CHƯA ĐẠT'}`);
  console.log(`- Thời gian < 1.5s (${payDown.duration}ms): ${check1_time ? '✅ ĐẠT' : '❌ CHƯA ĐẠT'}`);
  console.log(`- Body có error và status="FAILED": ${check1_body ? '✅ ĐẠT' : '❌ CHƯA ĐẠT'}`);

  // Bước 2: Kiểm tra Fee Service còn sống
  console.log('\n--- [Bước 2] Kiểm tra Fee Service không bị crash & GET /fees nhanh ---');
  const feeCheck = await request(`${FEE_URL}/students/1/fees`);
  console.log(`⏱️ Thời gian phản hồi GET /fees: ${feeCheck.duration} ms`);
  console.log(`📥 HTTP Status: ${feeCheck.statusCode}`);
  console.log('📦 Công nợ sinh viên 1:', feeCheck.data);

  const check2_alive = feeCheck.statusCode === 200 && feeCheck.duration < 300;
  console.log(`- Fee Service sống sót & phản hồi < 300ms: ${check2_alive ? '✅ ĐẠT' : '❌ CHƯA ĐẠT'}`);

  // Bước 3: Sau khi Ngân hàng chạy lại
  console.log('\n--- [Bước 3] Kiểm tra khi Ngân hàng HOẠT ĐỘNG TRỞ LẠI ---');
  console.log('Gửi lại POST /students/1/payments {"amount": 100000}...');
  const payUp = await request(`${FEE_URL}/students/1/payments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { amount: 100000 });

  console.log(`⏱️ Thời gian phản hồi: ${payUp.duration} ms`);
  console.log(`📥 HTTP Status: ${payUp.statusCode}`);
  console.log('📦 Response Body:', JSON.stringify(payUp.data, null, 2));

  const check3_success = payUp.statusCode === 201 && payUp.data.status === 'PAID';
  console.log(`- Trả về 201 PAID khi ngân hàng chạy lại: ${check3_success ? '✅ ĐẠT' : '❌ CHƯA ĐẠT'}`);

  const passed = check1_status && check1_time && check1_body && check2_alive && check3_success;
  console.log('\n================================================================');
  console.log(`KẾT QUẢ TÌNH HUỐNG 1: ${passed ? '🎉 HOÀN TOÀN ĐẠT CHUẨN' : '⚠️ CẦN KIỂM TRA LẠI'}`);
  console.log('================================================================\n');

  return { passed, payDown, feeCheck, payUp };
}

if (require.main === module) runScenario1();
module.exports = runScenario1;
