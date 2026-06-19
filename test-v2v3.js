/**
 * test-v2v3.js — Test feature V2/V3: similarity (Qdrant), flyer search,
 * forecast (ML service), route optimizer.
 * Verifica che con Qdrant/ML giù gli endpoint NON diano 500 (graceful fallback).
 */
require('dotenv').config();

const BASE = 'http://127.0.0.1:3000';
let token = '';

const c = {
  green: s => `\x1b[32m${s}\x1b[0m`,
  red:   s => `\x1b[31m${s}\x1b[0m`,
  cyan:  s => `\x1b[36m${s}\x1b[0m`,
  bold:  s => `\x1b[1m${s}\x1b[0m`,
};
let passed = 0, failed = 0;
const failures = [];

async function req(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try { data = await res.json(); } catch { data = {}; }
  return { status: res.status, data };
}

async function test(name, fn) {
  process.stdout.write(`  ${c.cyan('→')} ${name} ... `);
  try { await fn(); console.log(c.green('✓')); passed++; }
  catch (e) { console.log(c.red(`✗ ${e.message}`)); failed++; failures.push({ name, error: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function run() {
  console.log(c.bold('\n🧪 Test V2/V3 — Qdrant, Flyer, Forecast, Routing\n'));

  // Login guest per il token
  const g = await req('POST', '/api/user/guest-login', { deviceId: `v2test-${Date.now()}` });
  token = g.data?.data?.accessToken;
  if (!token) { console.error('Guest login fallito:', g.status, JSON.stringify(g.data)); process.exit(1); }
  console.log(`  Token guest ok\n`);

  console.log(c.bold('V2 — Similarity (Qdrant)'));
  await test('POST /api/similarity/find → niente 500', async () => {
    const r = await req('POST', '/api/similarity/find', { name: 'Nutella crema spalmabile', limit: 5 });
    assert(r.status < 500, `got ${r.status}: ${JSON.stringify(r.data).slice(0, 150)}`);
  });
  await test('POST /api/similarity/index → niente 500', async () => {
    const r = await req('POST', '/api/similarity/index', { name: 'Pasta Barilla spaghetti', price: 1.20 });
    assert(r.status < 500, `got ${r.status}: ${JSON.stringify(r.data).slice(0, 150)}`);
  });

  console.log(c.bold('\nV2 — Flyer semantic search (Qdrant)'));
  await test('GET /api/flyer/search?q=formaggi → niente 500', async () => {
    const r = await req('GET', '/api/flyer/search?q=formaggi%20per%20pizza');
    assert(r.status < 500, `got ${r.status}: ${JSON.stringify(r.data).slice(0, 150)}`);
  });
  await test('GET /api/flyer/price-history → niente 500', async () => {
    const r = await req('GET', '/api/flyer/price-history?productKey=latte');
    assert(r.status < 500, `got ${r.status}: ${JSON.stringify(r.data).slice(0, 150)}`);
  });

  console.log(c.bold('\nV3 — Forecast (ML service Prophet)'));
  await test('GET /api/forecast/price → niente 500 (fallback DB)', async () => {
    const r = await req('GET', '/api/forecast/price?productKey=latte');
    assert(r.status < 500, `got ${r.status}: ${JSON.stringify(r.data).slice(0, 150)}`);
  });
  await test('GET /api/forecast/competitor → niente 500', async () => {
    const r = await req('GET', '/api/forecast/competitor?productKey=latte');
    assert(r.status < 500, `got ${r.status}: ${JSON.stringify(r.data).slice(0, 150)}`);
  });

  console.log(c.bold('\nV3 — Route optimizer'));
  await test('POST /api/routing/optimize → niente 500 (fallback Node)', async () => {
    const r = await req('POST', '/api/routing/optimize', {
      start: { lat: 41.9028, lon: 12.4964 },
      stops: [
        { name: 'Conad', lat: 41.91, lon: 12.50 },
        { name: 'Lidl',  lat: 41.89, lon: 12.48 },
      ],
    });
    assert(r.status < 500, `got ${r.status}: ${JSON.stringify(r.data).slice(0, 150)}`);
  });

  console.log(c.bold('\nPromos e Stores (per la home dell\'app)'));
  await test('GET /api/promos → niente 500', async () => {
    const r = await req('GET', '/api/promos?latitude=41.9&longitude=12.49');
    assert(r.status < 500, `got ${r.status}`);
  });
  await test('GET /api/stores/location → niente 500', async () => {
    const r = await req('GET', `/api/stores/location?a=${encodeURIComponent(JSON.stringify([12.4964, 41.9028]))}`);
    assert(r.status < 500, `got ${r.status}`);
  });

  console.log('\n' + '═'.repeat(50));
  console.log(`  ${c.green(`✓ ${passed} passati`)}${failed ? '  ' + c.red(`✗ ${failed} falliti`) : ''}`);
  if (failures.length) failures.forEach(f => console.log(`  ${c.red('•')} ${f.name}: ${f.error}`));
  console.log('═'.repeat(50) + '\n');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error('Errore fatale:', e.message); process.exit(1); });
