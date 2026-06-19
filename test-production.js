/**
 * test-production.js — Test suite completa pre-produzione DealCart
 *
 * Copre: auth E2E (con OTP reale dal DB), validazione input, CRUD cart/pantry/
 * nutrition, gamification, chat, receipts, sicurezza (401/403/IDOR/admin).
 *
 * IMPORTANTE: riavvia il backend prima di eseguire (i rate limit sono in-memory
 * e questa suite consuma quasi tutti i tentativi disponibili).
 *
 * Esegui con: node test-production.js
 */
require('dotenv').config();
const prisma = require('./src/config/database');

const BASE = 'http://127.0.0.1:3000';
const RUN  = Date.now();
const TEST_EMAIL = `prodtest_${RUN}@dealcart.test`;
const TEST_PASS  = 'ProdTest123!';

let token = '';        // token utente verificato
let guestToken = '';   // token guest (secondo utente per IDOR test)
let refreshToken = '';
let guestSessionId = ''; // chat session del guest, per IDOR

const c = {
  green: s => `\x1b[32m${s}\x1b[0m`,
  red:   s => `\x1b[31m${s}\x1b[0m`,
  cyan:  s => `\x1b[36m${s}\x1b[0m`,
  bold:  s => `\x1b[1m${s}\x1b[0m`,
  yellow:s => `\x1b[33m${s}\x1b[0m`,
};

let passed = 0, failed = 0;
const failures = [];

async function req(method, path, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const useToken = opts.token !== undefined ? opts.token : token;
  if (useToken) headers.Authorization = `Bearer ${useToken}`;
  const res = await fetch(`${BASE}${path}`, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try { data = await res.json(); } catch { data = {}; }
  return { status: res.status, data };
}

async function test(name, fn) {
  process.stdout.write(`  ${c.cyan('→')} ${name} ... `);
  try {
    await fn();
    console.log(c.green('✓'));
    passed++;
  } catch (e) {
    console.log(c.red(`✗ ${e.message}`));
    failed++;
    failures.push({ name, error: e.message });
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

function section(title) { console.log(`\n${c.bold(title)}`); }

// Legge l'OTP corrente di un utente direttamente dal DB
async function getOtpFromDb(email) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return null;
  const otp = await prisma.otp.findFirst({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } });
  return otp?.code ?? null;
}

async function run() {
  console.log(c.bold('\n🧪 DealCart — Test Suite Pre-Produzione'));
  console.log(`   ${BASE} | ${TEST_EMAIL}\n`);

  // ════════════════════════════════════════════════════════════════════════
  section('1. AUTH — Validazione input');
  await test('signup email invalida → 400', async () => {
    const r = await req('POST', '/api/user/signup', { email: 'notanemail', password: TEST_PASS });
    assert(r.status === 400, `got ${r.status}`);
  });
  await test('signup password corta → 400', async () => {
    const r = await req('POST', '/api/user/signup', { email: `x_${RUN}@test.com`, password: '123' });
    assert(r.status === 400, `got ${r.status}`);
  });

  // ════════════════════════════════════════════════════════════════════════
  section('2. AUTH — Flusso completo signup → OTP → login');
  await test('signup valido (con lingua es) → 201', async () => {
    const r = await req('POST', '/api/user/signup', { name: 'Prod Test', email: TEST_EMAIL, password: TEST_PASS, language: 'es' });
    assert(r.status === 201, `got ${r.status}: ${JSON.stringify(r.data)}`);
    assert(r.data?.data?.emailHint, 'emailHint mancante');
  });
  await test('login PRIMA della verifica → 403', async () => {
    const r = await req('POST', '/api/user/login', { email: TEST_EMAIL, password: TEST_PASS });
    assert(r.status === 403, `got ${r.status} (atteso 403 non verificato)`);
  });
  await test('ri-signup con email non verificata → 201 (rigenera OTP)', async () => {
    const r = await req('POST', '/api/user/signup', { name: 'Prod Test', email: TEST_EMAIL, password: TEST_PASS });
    assert(r.status === 201, `got ${r.status}: ${JSON.stringify(r.data)}`);
  });
  await test('verify-otp con codice sbagliato → 400', async () => {
    const r = await req('POST', '/api/user/verify-otp', { email: TEST_EMAIL, otp: '000000' });
    assert(r.status === 400, `got ${r.status}`);
  });
  await test('resend-otp → 200', async () => {
    const r = await req('POST', '/api/user/resend-otp', { email: TEST_EMAIL });
    assert(r.status === 200, `got ${r.status}: ${JSON.stringify(r.data)}`);
  });
  await test('verify-otp con codice corretto (dal DB) → 200 + token', async () => {
    const otp = await getOtpFromDb(TEST_EMAIL);
    assert(otp, 'OTP non trovato nel DB');
    const r = await req('POST', '/api/user/verify-otp', { email: TEST_EMAIL, otp });
    assert(r.status === 200, `got ${r.status}: ${JSON.stringify(r.data)}`);
    assert(r.data?.data?.accessToken, 'accessToken mancante');
    assert(r.data?.data?.user?.isVerified === true, 'user non verificato dopo OTP');
    token = r.data.data.accessToken;
    refreshToken = r.data.data.refreshToken;
  });
  await test('sanitizeUser: no password/fcmToken/googleId nella risposta', async () => {
    const r = await req('GET', '/api/user/me');
    assert(r.status === 200, `got ${r.status}`);
    const u = r.data?.data?.user;
    assert(u && !('password' in u) && !('fcmToken' in u) && !('googleId' in u),
      'campi sensibili esposti');
    assert(u.language === 'es', `lingua non persistita dal signup: ${u.language} (attesa es)`);
  });
  await test('signup duplicato (email verificata) → 400', async () => {
    const r = await req('POST', '/api/user/signup', { email: TEST_EMAIL, password: TEST_PASS });
    assert(r.status === 400, `got ${r.status}`);
  });
  await test('login con password sbagliata → 401', async () => {
    const r = await req('POST', '/api/user/login', { email: TEST_EMAIL, password: 'WrongPass123!' });
    assert(r.status === 401, `got ${r.status}`);
  });
  await test('login corretto → 200 + token', async () => {
    const r = await req('POST', '/api/user/login', { email: TEST_EMAIL, password: TEST_PASS });
    assert(r.status === 200, `got ${r.status}: ${JSON.stringify(r.data)}`);
    assert(r.data?.data?.accessToken, 'accessToken mancante');
    token = r.data.data.accessToken;
    refreshToken = r.data.data.refreshToken;
  });

  // ════════════════════════════════════════════════════════════════════════
  section('3. AUTH — Refresh token rotation');
  await test('refresh valido → 200 + nuova coppia token', async () => {
    const r = await req('POST', '/api/user/refresh', { refreshToken });
    assert(r.status === 200, `got ${r.status}: ${JSON.stringify(r.data)}`);
    const d = r.data?.data;
    assert(d?.accessToken && d?.refreshToken, 'nuova coppia mancante');
    assert(d.refreshToken !== refreshToken, 'refresh token NON ruotato');
    token = d.accessToken;
    const oldRefresh = refreshToken;
    refreshToken = d.refreshToken;
    // anti-replay: il vecchio token deve essere invalidato
    const r2 = await req('POST', '/api/user/refresh', { refreshToken: oldRefresh });
    assert(r2.status === 401, `replay vecchio token: got ${r2.status} (atteso 401)`);
  });

  // ════════════════════════════════════════════════════════════════════════
  section('4. GUEST LOGIN');
  await test('guest-login → 200 + token + isVerified', async () => {
    const r = await req('POST', '/api/user/guest-login', { deviceId: `test-${RUN}` }, { token: '' });
    assert(r.status === 200, `got ${r.status}`);
    guestToken = r.data?.data?.accessToken;
    assert(guestToken, 'guest token mancante');
    assert(r.data.data.user.isVerified === true, 'guest non verificato');
  });

  // ════════════════════════════════════════════════════════════════════════
  section('4b. GOOGLE AUTH');
  await test('google-auth senza idToken → 400', async () => {
    const r = await req('POST', '/api/user/google-auth', {}, { token: '' });
    assert(r.status === 400, `got ${r.status}`);
  });
  await test('google-auth con idToken falso → 401', async () => {
    const r = await req('POST', '/api/user/google-auth', { idToken: 'fake.invalid.token' }, { token: '' });
    assert(r.status === 401, `got ${r.status}: ${JSON.stringify(r.data).slice(0, 150)}`);
  });

  // ════════════════════════════════════════════════════════════════════════
  section('5. SICUREZZA — Token e accessi');
  await test('endpoint protetto senza token → 401', async () => {
    const r = await req('GET', '/api/cart/', null, { token: '' });
    assert(r.status === 401, `got ${r.status}`);
  });
  await test('token falso → 401', async () => {
    const r = await req('GET', '/api/cart/', null, { token: 'fake.jwt.token' });
    assert(r.status === 401, `got ${r.status}`);
  });
  await test('token con firma sbagliata → 401', async () => {
    // JWT valido come struttura ma firmato con secret diverso
    const fake = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ4Iiwic WF0IjoxfQ.invalid'.replace(' ', '');
    const r = await req('GET', '/api/cart/', null, { token: fake });
    assert(r.status === 401, `got ${r.status}`);
  });
  await test('getAllUsers senza admin key → 403', async () => {
    const r = await req('GET', '/api/user/getAllUsers');
    assert(r.status === 403, `got ${r.status}`);
  });
  await test('getAllUsers con admin key sbagliata → 403', async () => {
    const r = await req('GET', '/api/user/getAllUsers', null, { headers: { 'X-Admin-Key': 'wrong-key' } });
    assert(r.status === 403, `got ${r.status}`);
  });
  await test('getAllUsers con admin key corretta → 200', async () => {
    const r = await req('GET', '/api/user/getAllUsers', null, { headers: { 'X-Admin-Key': process.env.ADMIN_API_KEY } });
    assert(r.status === 200, `got ${r.status}`);
  });
  await test('route inesistente → 404 con shape standard', async () => {
    const r = await req('GET', '/api/route-che-non-esiste');
    assert(r.status === 404, `got ${r.status}`);
    assert(r.data?.success === false && r.data?.message, 'shape errore non standard');
  });

  // ════════════════════════════════════════════════════════════════════════
  section('6. IDOR — Isolamento tra utenti');
  await test('guest crea chat session', async () => {
    // crea sessione direttamente nel DB per non consumare l'API AI
    const guestUser = await prisma.user.findFirst({
      where: { email: { startsWith: 'guest_' } },
      orderBy: { createdAt: 'desc' },
    });
    assert(guestUser, 'guest non trovato nel DB');
    const session = await prisma.chatSession.create({
      data: { userId: guestUser.id, title: 'Sessione privata guest' },
    });
    guestSessionId = session.id;
    assert(guestSessionId, 'sessione non creata');
  });
  await test('utente A NON può leggere chat session di utente B → 404', async () => {
    const r = await req('GET', `/api/chat/sessions/${guestSessionId}/messages`);
    assert(r.status === 404, `got ${r.status} — IDOR VULNERABILITY se 200!`);
  });

  // ════════════════════════════════════════════════════════════════════════
  section('7. CART — CRUD e validazione');
  let productId;
  await test('setup: crea store + prodotto di test', async () => {
    const store = await prisma.store.create({
      data: { name: `TestStore_${RUN}`, latitude: 41.9, longitude: 12.49, chain: 'Conad' },
    });
    const product = await prisma.product.create({
      data: { name: `TestProdotto_${RUN}`, storeId: store.id, price: 2.50, barcode: `800${RUN}` },
    });
    productId = product.id;
    assert(productId, 'prodotto non creato');
  });
  await test('add to cart → 201', async () => {
    const r = await req('POST', '/api/cart/add', { productId, quantity: 2 });
    assert(r.status === 201, `got ${r.status}: ${JSON.stringify(r.data)}`);
  });
  await test('add quantity negativa → 400', async () => {
    const r = await req('POST', '/api/cart/add', { productId, quantity: -5 });
    assert(r.status === 400, `got ${r.status} — quantity negativa accettata!`);
  });
  await test('add quantity decimale → 400', async () => {
    const r = await req('POST', '/api/cart/add', { productId, quantity: 2.5 });
    assert(r.status === 400, `got ${r.status}`);
  });
  await test('add quantity stringa → 400', async () => {
    const r = await req('POST', '/api/cart/add', { productId, quantity: 'tanti' });
    assert(r.status === 400, `got ${r.status}`);
  });
  await test('add productId inesistente → 404', async () => {
    const r = await req('POST', '/api/cart/add', { productId: '00000000-0000-0000-0000-000000000000', quantity: 1 });
    assert(r.status === 404, `got ${r.status}`);
  });
  await test('get cart → 200 con totale corretto', async () => {
    const r = await req('GET', '/api/cart/');
    assert(r.status === 200, `got ${r.status}`);
    const items = r.data?.data?.items;
    assert(Array.isArray(items) && items.length === 1, `items: ${items?.length}`);
    assert(items[0].quantity === 2, `quantity: ${items[0].quantity}`);
    assert(r.data.data.total === 5.0, `total: ${r.data.data.total} (atteso 5.00)`);
  });
  await test('update quantity → 200', async () => {
    const r = await req('PUT', '/api/cart/update', { productId, quantity: 3 });
    assert(r.status === 200, `got ${r.status}: ${JSON.stringify(r.data)}`);
    assert(r.data?.data?.item?.quantity === 3, 'quantity non aggiornata');
  });
  await test('update prodotto non in carrello → 404', async () => {
    const r = await req('PUT', '/api/cart/update', { productId: '00000000-0000-0000-0000-000000000000', quantity: 1 });
    assert(r.status === 404, `got ${r.status} — era 500 prima del fix`);
  });
  await test('update quantity 0 → rimuove item', async () => {
    const r = await req('PUT', '/api/cart/update', { productId, quantity: 0 });
    assert(r.status === 200, `got ${r.status}`);
    const cart = await req('GET', '/api/cart/');
    assert(cart.data?.data?.items?.length === 0, 'item non rimosso');
  });

  // ════════════════════════════════════════════════════════════════════════
  section('8. PANTRY — CRUD');
  let pantryItemId;
  await test('add pantry item → 200/201', async () => {
    const r = await req('POST', '/api/pantry/items', { name: 'Latte test', category: 'latticini', quantity: 2, unit: 'l' });
    assert([200, 201].includes(r.status), `got ${r.status}: ${JSON.stringify(r.data)}`);
    pantryItemId = r.data?.data?.item?.id ?? r.data?.data?.id;
    assert(pantryItemId, 'id item mancante');
  });
  await test('get pantry → 200 con item', async () => {
    const r = await req('GET', '/api/pantry');
    assert(r.status === 200, `got ${r.status}`);
    const items = r.data?.data?.items ?? r.data?.data;
    assert(Array.isArray(items) && items.length >= 1, 'pantry vuota');
  });
  await test('update pantry item → 200', async () => {
    const r = await req('PUT', `/api/pantry/${pantryItemId}`, { quantity: 1 });
    assert(r.status === 200, `got ${r.status}: ${JSON.stringify(r.data)}`);
  });
  await test('delete pantry item → 200', async () => {
    const r = await req('DELETE', `/api/pantry/${pantryItemId}`);
    assert(r.status === 200, `got ${r.status}`);
  });
  await test('delete pantry item di altro utente → 404/403', async () => {
    // crea item come guest, prova a cancellarlo come utente A
    const guestUser = await prisma.user.findFirst({ where: { email: { startsWith: 'guest_' } }, orderBy: { createdAt: 'desc' } });
    const item = await prisma.pantryItem.create({ data: { userId: guestUser.id, name: 'Item del guest' } });
    const r = await req('DELETE', `/api/pantry/${item.id}`);
    assert([403, 404].includes(r.status), `got ${r.status} — IDOR su pantry!`);
  });

  // ════════════════════════════════════════════════════════════════════════
  section('9. NUTRITION');
  await test('get nutrition profile → 200', async () => {
    const r = await req('GET', '/api/nutrition/profile');
    assert([200].includes(r.status), `got ${r.status}`);
  });
  await test('update nutrition profile → 200', async () => {
    const r = await req('PUT', '/api/nutrition/profile', { dietType: ['vegetarian'], dailyCalories: 2000 });
    assert(r.status === 200, `got ${r.status}: ${JSON.stringify(r.data)}`);
  });

  // ════════════════════════════════════════════════════════════════════════
  section('10. GAMIFICATION');
  await test('get profile → 200 con livello bronze', async () => {
    const r = await req('GET', '/api/gamification/profile');
    assert(r.status === 200, `got ${r.status}`);
    assert(r.data?.data?.level === 'bronze', `level: ${r.data?.data?.level}`);
  });
  await test('get voucher catalog → 200', async () => {
    const r = await req('GET', '/api/gamification/vouchers/catalog');
    assert(r.status === 200, `got ${r.status}`);
    assert(Array.isArray(r.data?.data?.catalog), 'catalog mancante');
  });
  await test('purchase voucher senza punti → 400', async () => {
    const r = await req('POST', '/api/gamification/vouchers/purchase', { catalogId: 'v1' });
    assert(r.status === 400, `got ${r.status} — voucher comprato senza punti!`);
  });
  await test('purchase voucher catalogId inesistente → 404', async () => {
    const r = await req('POST', '/api/gamification/vouchers/purchase', { catalogId: 'vXX' });
    assert(r.status === 404, `got ${r.status}`);
  });
  await test('use voucher con formato invalido → 400', async () => {
    const r = await req('POST', '/api/gamification/vouchers/use', { code: 'HACK-INJECT' });
    assert(r.status === 400, `got ${r.status}`);
  });
  await test('leaderboard → 200 con dati anonimizzati', async () => {
    const r = await req('GET', '/api/gamification/leaderboard');
    assert(r.status === 200, `got ${r.status}`);
    const lb = r.data?.data?.leaderboard;
    assert(Array.isArray(lb), 'leaderboard mancante');
    // verifica anonimizzazione: nessun nome completo né UUID
    for (const row of lb) {
      assert(!row.userId, 'userId esposto in leaderboard!');
      if (row.name && row.name !== 'Utente') {
        assert(row.name.includes('***'), `nome non anonimizzato: ${row.name}`);
      }
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  section('11. RECEIPTS');
  await test('get receipts → 200 lista vuota', async () => {
    const r = await req('GET', '/api/receipts');
    assert(r.status === 200, `got ${r.status}`);
  });
  await test('get stats con months fuori range → 200 (clamp) o 400', async () => {
    const r = await req('GET', '/api/receipts/stats?months=999');
    assert([200, 400].includes(r.status), `got ${r.status}`);
  });
  await test('get receipt inesistente → 404', async () => {
    const r = await req('GET', '/api/receipts/00000000-0000-0000-0000-000000000000');
    assert(r.status === 404, `got ${r.status}`);
  });
  await test('scan senza immagine → 400', async () => {
    const res = await fetch(`${BASE}/api/receipts/scan`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert(res.status === 400, `got ${res.status}`);
  });

  // ════════════════════════════════════════════════════════════════════════
  section('12. CHAT');
  await test('get sessions → 200', async () => {
    const r = await req('GET', '/api/chat/sessions');
    assert(r.status === 200, `got ${r.status}`);
  });
  await test('messaggio vuoto → 400', async () => {
    const r = await req('POST', '/api/chat/message', { message: '   ' });
    assert(r.status === 400, `got ${r.status}`);
  });
  await test('messaggio oltre 2000 char → 400', async () => {
    const r = await req('POST', '/api/chat/message', { message: 'x'.repeat(2001) });
    assert(r.status === 400, `got ${r.status} — DoS sui costi AI possibile!`);
  });

  // ════════════════════════════════════════════════════════════════════════
  section('13. PROFILE — Validazione');
  await test('edit profile budget negativo → 400', async () => {
    const r = await req('PATCH', '/api/user/edit-profile', { monthlyBudget: -100 });
    assert(r.status === 400, `got ${r.status}`);
  });
  await test('edit profile budget valido → 200', async () => {
    const r = await req('PATCH', '/api/user/edit-profile', { monthlyBudget: 400, language: 'it' });
    assert(r.status === 200, `got ${r.status}`);
    assert(r.data?.data?.user?.monthlyBudget === 400, 'budget non salvato');
  });

  // ════════════════════════════════════════════════════════════════════════
  section('14. LOGOUT');
  await test('logout → 200 e refresh token invalidato', async () => {
    const r = await req('POST', '/api/user/logout', { refreshToken });
    assert(r.status === 200, `got ${r.status}`);
    const r2 = await req('POST', '/api/user/refresh', { refreshToken });
    assert(r2.status === 401, `refresh dopo logout: got ${r2.status} (atteso 401)`);
  });

  // ════════════════════════════════════════════════════════════════════════
  // CLEANUP
  section('15. CLEANUP dati di test');
  await test('rimozione dati di test dal DB', async () => {
    await prisma.user.deleteMany({ where: { email: { contains: `prodtest_${RUN}` } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: 'guest_' }, createdAt: { gte: new Date(RUN - 60000) } } });
    await prisma.product.deleteMany({ where: { name: { contains: `TestProdotto_${RUN}` } } });
    await prisma.store.deleteMany({ where: { name: { contains: `TestStore_${RUN}` } } });
  });

  // ════════════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(55));
  console.log(c.bold('RISULTATI FINALI'));
  console.log('═'.repeat(55));
  console.log(`  ${c.green(`✓ ${passed} passati`)}`);
  if (failed) {
    console.log(`  ${c.red(`✗ ${failed} falliti:`)}`);
    failures.forEach(f => console.log(`    ${c.red('•')} ${f.name}\n      ${f.error}`));
  } else {
    console.log(`  ${c.green('🚀 TUTTI I TEST PASSANO — pronto per produzione')}`);
  }
  console.log('═'.repeat(55) + '\n');

  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(async e => {
  console.error(c.red('\n❌ Errore fatale:'), e);
  await prisma.$disconnect();
  process.exit(1);
});
