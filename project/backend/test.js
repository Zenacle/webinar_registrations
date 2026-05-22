const http = require('http');

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: 'localhost',
      port: 5000,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const req = http.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function run() {
  console.log('\n========== TEST 1: GET / (health check) ==========');
  await new Promise((resolve) => {
    http.get('http://localhost:5000/', (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => { console.log('Status:', res.statusCode, '| Response:', raw); resolve(); });
    }).on('error', (e) => { console.error('ERROR:', e.message); resolve(); });
  });

  console.log('\n========== TEST 2: POST /validate-promo (ZEN70) ==========');
  const r1 = await post('/validate-promo', {
    promoCode: 'ZEN70',
    email: 'test@example.com',
    phone: '9999999999',
  });
  console.log('Status:', r1.status);
  console.log('Response:', JSON.stringify(r1.body, null, 2));

  console.log('\n========== TEST 3: POST /validate-promo (invalid code) ==========');
  const r2 = await post('/validate-promo', {
    promoCode: 'BADCODE',
    email: 'test@example.com',
    phone: '9999999999',
  });
  console.log('Status:', r2.status);
  console.log('Response:', JSON.stringify(r2.body, null, 2));

  console.log('\n========== TEST 4: POST /validate-promo (no promo code) ==========');
  const r3 = await post('/validate-promo', {
    promoCode: '',
    email: 'test@example.com',
    phone: '9999999999',
  });
  console.log('Status:', r3.status);
  console.log('Response:', JSON.stringify(r3.body, null, 2));

  console.log('\n========== TEST 5: POST /validate-promo (ZEN100 - free) ==========');
  const r4 = await post('/validate-promo', {
    promoCode: 'ZEN100',
    email: 'test@example.com',
    phone: '9999999999',
  });
  console.log('Status:', r4.status);
  console.log('Response:', JSON.stringify(r4.body, null, 2));

  console.log('\n========== TEST 6: POST /create-order (ZEN70) ==========');
  const r5 = await post('/create-order', {
    promoCode: 'ZEN70',
    leadData: {
      fullName: 'Test User',
      email: 'test@example.com',
      phone: '9999999999',
      city: 'Mumbai',
      background: 'Civil',
      session: 'Batch 1',
    },
  });
  console.log('Status:', r5.status);
  console.log('Response:', JSON.stringify(r5.body, null, 2));

  console.log('\n========== ALL TESTS COMPLETE ==========\n');
}

run().catch(console.error);
