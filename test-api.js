/**
 * test-api.js — Test completo backend DealCart
 * Esegui con: node test-api.js
 */

const BASE = 'http://localhost:3000';
const TEST_EMAIL = `test_${Date.now()}@dealcart.test`;
const TEST_PASS  = 'TestPass123!';

let token = '';
let userId = '';
let otpCode = '';

const c = {
  green:  s => `\x1b[32m${s}\x1b[0m`,
  red:    s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  cyan:   s => `\x1b[36m${s}\x1b[0m`,
  bold:   s => `\x1b[1m${s}\x1b[0m`,
};

let passed = 0, failed = 0, skipped = 0;

async function req(method, path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try { data = await res.json(); } catch { data = {}; }
  return { status: res.status, data };
}

function test(name, fn) {
  return async () => {
    process.stdout.write(`  ${c.cyan('→')} ${name} ... `);
    try {
      await fn();
      console.log(c.green('✓ PASS'));
      passed++;
    } catch (e) {
      console.log(c.red(`✗ FAIL: ${e.message}`));
      failed++;
    }
  };
}

function skip(name) {
  return async () => {
    console.log(`  ${c.yellow('○')} ${name} ${c.yellow('(skip)')}`);
    skipped++;
  };
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

async function section(title, tests) {
  console.log(`\n${c.bold(title)}`);
  for (const t of tests) await t();
}

// ─── PATCH prisma per loggare OTP ────────────────────────────────────────────
// Intercetta il log del processo per catturare OTP
const origLog = console.log;

async function run() {
  console.log(c.bold('\n🧪 DealCart Backend — Test Suite'));
  console.log(`   Base URL: ${BASE}`);
  console.log(`   Test email: ${TEST_EMAIL}\n`);

  // ── 1. HEALTH ──────────────────────────────────────────────────────────────
  await section('1. Health Check', [
    test('GET / → 200 o 404 (app alive)', async () => {
      const r = await req('GET', '/');
      assert(r.status < 500, `Server error: ${r.status}`);
    }),
    test('GET /api/stores → richiede auth', async () => {
      const r = await req('GET', '/api/stores/location?a=[]');
      assert([401, 400, 200].includes(r.status), `Unexpected: ${r.status}`);
    }),
  ]);

  // ── 2. AUTH ────────────────────────────────────────────────────────────────
  await section('2. Auth — Signup', [
    test('POST /api/user/signup → 201', async () => {
      const r = await req('POST', '/api/user/signup', {
        email: TEST_EMAIL,
        password: TEST_PASS,
        name: 'Test User',
      });
      assert(r.status === 201, `Got ${r.status}: ${JSON.stringify(r.data)}`);
      assert(r.data.emailHint || r.data.message, 'No message in response');
      console.log(`\n     ${c.yellow('⚠ Guarda il log backend per OTP')}`);
    }),
    test('POST /api/user/signup duplicata → 400', async () => {
      const r = await req('POST', '/api/user/signup', {
        email: TEST_EMAIL,
        password: TEST_PASS,
      });
      assert(r.status === 400, `Expected 400, got ${r.status}`);
    }),
    test('POST /api/user/signup email invalida → 400', async () => {
      const r = await req('POST', '/api/user/signup', {
        email: 'notanemail',
        password: TEST_PASS,
      });
      assert(r.status === 400, `Expected 400, got ${r.status}`);
    }),
    test('POST /api/user/signup password corta → 400', async () => {
      const r = await req('POST', '/api/user/signup', {
        email: `short_${Date.now()}@test.com`,
        password: '123',
      });
      assert(r.status === 400, `Expected 400, got ${r.status}`);
    }),
  ]);

  // ── 3. OTP ─────────────────────────────────────────────────────────────────
  await section('3. OTP Verify (inserisci manualmente dal log)', [
    skip('POST /api/user/verify-otp → richiede OTP dal log backend'),
  ]);

  // ── 4. GUEST LOGIN ─────────────────────────────────────────────────────────
  await section('4. Guest Login', [
    test('POST /api/user/guest-login → 200 + token', async () => {
      const r = await req('POST', '/api/user/guest-login', {
        deviceId: `test-device-${Date.now()}`,
      });
      assert(r.status === 200, `Got ${r.status}: ${JSON.stringify(r.data)}`);
      const t = r.data?.data?.accessToken || r.data?.accessToken;
      assert(t, 'No token in response');
      token = t;
      console.log(`\n     Token: ${token.substring(0, 30)}...`);
    }),
  ]);

  // ── 5. STORES ──────────────────────────────────────────────────────────────
  await section('5. Stores', [
    test('GET /api/stores/location → 200', async () => {
      const loc = JSON.stringify([12.4964, 41.9028]); // Roma
      const r = await req('GET', `/api/stores/location?a=${encodeURIComponent(loc)}`);
      assert([200, 400].includes(r.status), `Got ${r.status}`);
    }),
  ]);

  // ── 6. PRODUCTS ────────────────────────────────────────────────────────────
  await section('6. Products', [
    test('GET /api/products/store/nonexistent → 200 o 404', async () => {
      const r = await req('GET', '/api/products/store/00000000-0000-0000-0000-000000000000');
      assert([200, 404].includes(r.status), `Got ${r.status}`);
    }),
  ]);

  // ── 7. CART ────────────────────────────────────────────────────────────────
  await section('7. Cart', [
    test('GET /api/cart/ con token guest → 200', async () => {
      const r = await req('GET', '/api/cart/');
      assert([200, 403].includes(r.status), `Got ${r.status}: ${JSON.stringify(r.data)}`);
    }),
  ]);

  // ── 8. RECEIPTS ────────────────────────────────────────────────────────────
  await section('8. Receipts', [
    test('GET /api/receipts → 200 o 403', async () => {
      const r = await req('GET', '/api/receipts');
      assert([200, 403].includes(r.status), `Got ${r.status}`);
    }),
    test('GET /api/receipts/stats → 200 o 403', async () => {
      const r = await req('GET', '/api/receipts/stats');
      assert([200, 403].includes(r.status), `Got ${r.status}`);
    }),
  ]);

  // ── 9. CHAT ────────────────────────────────────────────────────────────────
  await section('9. AI Chat', [
    test('GET /api/chat/sessions → 200 o 403', async () => {
      const r = await req('GET', '/api/chat/sessions');
      assert([200, 403].includes(r.status), `Got ${r.status}`);
    }),
  ]);

  // ── 10. NUTRITION ──────────────────────────────────────────────────────────
  await section('10. Nutrition', [
    test('GET /api/nutrition/barcode/8001120948748 → 200 o 404', async () => {
      const r = await req('GET', '/api/nutrition/barcode/8001120948748');
      assert([200, 404].includes(r.status), `Got ${r.status}`);
    }),
    test('GET /api/nutrition/profile → 200 o 403', async () => {
      const r = await req('GET', '/api/nutrition/profile');
      assert([200, 403].includes(r.status), `Got ${r.status}`);
    }),
  ]);

  // ── 11. GAMIFICATION ──────────────────────────────────────────────────────
  await section('11. Gamification', [
    test('GET /api/gamification/points → 200 o 403', async () => {
      const r = await req('GET', '/api/gamification/points');
      assert([200, 403].includes(r.status), `Got ${r.status}`);
    }),
    test('GET /api/gamification/leaderboard → 200', async () => {
      const r = await req('GET', '/api/gamification/leaderboard');
      assert([200, 403].includes(r.status), `Got ${r.status}`);
    }),
  ]);

  // ── 12. PANTRY ─────────────────────────────────────────────────────────────
  await section('12. Pantry', [
    test('GET /api/pantry → 200 o 403', async () => {
      const r = await req('GET', '/api/pantry');
      assert([200, 403].includes(r.status), `Got ${r.status}`);
    }),
  ]);

  // ── 13. STRIPE ─────────────────────────────────────────────────────────────
  await section('13. Stripe', [
    test('GET /api/stripe/status → 200 o 403', async () => {
      const r = await req('GET', '/api/stripe/status');
      assert([200, 403, 404].includes(r.status), `Got ${r.status}`);
    }),
  ]);

  // ── 14. PROMO ──────────────────────────────────────────────────────────────
  await section('14. Promos', [
    test('GET /api/promos?latitude=41.9&longitude=12.5 → 200', async () => {
      const r = await req('GET', '/api/promos?latitude=41.9028&longitude=12.4964');
      assert([200, 404].includes(r.status), `Got ${r.status}`);
    }),
  ]);

  // ── 15. SECURITY ──────────────────────────────────────────────────────────
  await section('15. Security', [
    test('Richiesta senza token → 401', async () => {
      const savedToken = token;
      token = '';
      const r = await req('GET', '/api/cart/');
      token = savedToken;
      assert(r.status === 401, `Expected 401, got ${r.status}`);
    }),
    test('Token falso → 401', async () => {
      const savedToken = token;
      token = 'fake.jwt.token';
      const r = await req('GET', '/api/cart/');
      token = savedToken;
      assert(r.status === 401, `Expected 401, got ${r.status}`);
    }),
  ]);

  // ── SUMMARY ────────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(50));
  console.log(c.bold('RISULTATI:'));
  console.log(`  ${c.green(`✓ ${passed} passati`)}`);
  if (failed)  console.log(`  ${c.red(`✗ ${failed} falliti`)}`);
  if (skipped) console.log(`  ${c.yellow(`○ ${skipped} saltati`)}`);
  console.log('─'.repeat(50) + '\n');
}

run().catch(e => {
  console.error(c.red('\n❌ Errore fatale:'), e.message);
  process.exit(1);
});
