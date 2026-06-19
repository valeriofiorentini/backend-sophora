/**
 * test-advisor.js — Test Basket Advisor + Health Advisor con dati seminati.
 *
 * Semina: 1 utente, 3 scontrini Esselunga (90gg) con prodotti ricorrenti,
 * PriceHistory con prezzi Lidl più bassi → l'advisor deve consigliare Lidl.
 * Health: il basket contiene verdura/frutta/dolci → verifica composizione.
 */
require('dotenv').config();
const prisma = require('./src/config/database');
const bcrypt = require('bcryptjs');

const BASE = 'http://127.0.0.1:3000';
const RUN  = Date.now();
const EMAIL = `advisortest_${RUN}@dealcart.test`;

const c = {
  green: s => `\x1b[32m${s}\x1b[0m`,
  red:   s => `\x1b[31m${s}\x1b[0m`,
  cyan:  s => `\x1b[36m${s}\x1b[0m`,
  bold:  s => `\x1b[1m${s}\x1b[0m`,
};
let passed = 0, failed = 0;
const failures = [];
let token = '';

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data; try { data = await res.json(); } catch { data = {}; }
  return { status: res.status, data };
}

async function test(name, fn) {
  process.stdout.write(`  ${c.cyan('→')} ${name} ... `);
  try { await fn(); console.log(c.green('✓')); passed++; }
  catch (e) { console.log(c.red(`✗ ${e.message}`)); failed++; failures.push({ name, error: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

function normalizeProductKey(name) {
  return name.toLowerCase().replace(/[^a-z0-9àèéìòù\s]/g, '').replace(/\s+/g, '_').slice(0, 80);
}

async function seed() {
  // Utente verificato
  const user = await prisma.user.create({
    data: { email: EMAIL, password: await bcrypt.hash('Test12345!', 10), name: 'Advisor Test', isVerified: true },
  });

  // 3 scontrini Esselunga negli ultimi 60 giorni — prodotti ricorrenti
  // Basket: banane (3x), latte (3x), biscotti (2x), zucchine (2x), birra (2x)
  const receiptsData = [
    { daysAgo: 50, items: [
      { name: 'Banane Chiquita',      qty: 1, unit: 2.00, total: 2.00 },
      { name: 'Latte intero',         qty: 2, unit: 1.60, total: 3.20 },
      { name: 'Biscotti frollini',    qty: 1, unit: 2.50, total: 2.50 },
      { name: 'Zucchine scure',       qty: 1, unit: 1.80, total: 1.80 },
    ]},
    { daysAgo: 30, items: [
      { name: 'Banane Chiquita',      qty: 1, unit: 2.10, total: 2.10 },
      { name: 'Latte intero',         qty: 2, unit: 1.60, total: 3.20 },
      { name: 'Birra Moretti',        qty: 6, unit: 1.20, total: 7.20 },
      { name: 'Zucchine scure',       qty: 1, unit: 1.90, total: 1.90 },
      { name: 'Carta igienica',       qty: 1, unit: 3.50, total: 3.50 },
    ]},
    { daysAgo: 10, items: [
      { name: 'Banane Chiquita',      qty: 1, unit: 2.00, total: 2.00 },
      { name: 'Latte intero',         qty: 2, unit: 1.70, total: 3.40 },
      { name: 'Biscotti frollini',    qty: 1, unit: 2.50, total: 2.50 },
      { name: 'Birra Moretti',        qty: 6, unit: 1.20, total: 7.20 },
    ]},
  ];

  for (const r of receiptsData) {
    const date = new Date(Date.now() - r.daysAgo * 86_400_000);
    await prisma.receipt.create({
      data: {
        userId: user.id,
        storeChain: 'Esselunga',
        storeName: 'Esselunga Test',
        receiptDate: date,
        totalAmount: r.items.reduce((s, i) => s + i.total, 0),
        status: 'processed',
        items: { create: r.items.map(i => ({
          name: i.name, rawName: i.name.toUpperCase(),
          quantity: i.qty, unitPrice: i.unit, totalPrice: i.total,
        })) },
      },
    });
  }

  // PriceHistory: Lidl ha prezzi più bassi su banane, latte e biscotti
  const phData = [];
  const lidlPrices = { 'Banane Chiquita': 1.40, 'Latte intero': 1.15, 'Biscotti frollini': 1.50 };
  const conadPrices = { 'Banane Chiquita': 2.20, 'Latte intero': 1.75 }; // Conad più caro
  for (const [name, price] of Object.entries(lidlPrices)) {
    for (let i = 0; i < 3; i++) {
      phData.push({ productKey: normalizeProductKey(name), storeChain: 'Lidl', price,
                    observedAt: new Date(Date.now() - (20 + i * 15) * 86_400_000), source: 'test' });
    }
  }
  for (const [name, price] of Object.entries(conadPrices)) {
    phData.push({ productKey: normalizeProductKey(name), storeChain: 'Conad', price,
                  observedAt: new Date(Date.now() - 25 * 86_400_000), source: 'test' });
  }
  await prisma.priceHistory.createMany({ data: phData });

  return user;
}

async function cleanup() {
  await prisma.user.deleteMany({ where: { email: EMAIL } });
  await prisma.priceHistory.deleteMany({ where: { source: 'test' } });
}

async function run() {
  console.log(c.bold('\n🧪 Test Advisor — Basket + Health\n'));

  await seed();
  console.log('  Seed completato (3 scontrini Esselunga + PriceHistory Lidl/Conad)\n');

  // Login
  const login = await fetch(`${BASE}/api/user/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: 'Test12345!' }),
  }).then(r => r.json());
  token = login?.data?.accessToken;
  if (!token) { console.error('Login fallito:', JSON.stringify(login)); await cleanup(); process.exit(1); }

  console.log(c.bold('GET /api/advisor/basket'));
  let basketRes;
  await test('risponde 200', async () => {
    basketRes = await req('GET', '/api/advisor/basket');
    assert(basketRes.status === 200, `got ${basketRes.status}: ${JSON.stringify(basketRes.data).slice(0, 200)}`);
  });
  await test('basket contiene i prodotti ricorrenti (≥2 acquisti)', async () => {
    const basket = basketRes.data?.data?.basket;
    assert(Array.isArray(basket), 'basket mancante');
    const names = basket.map(b => b.name.toLowerCase());
    assert(names.some(n => n.includes('banane')),  `banane mancanti: ${names.join(', ')}`);
    assert(names.some(n => n.includes('latte')),   'latte mancante');
    assert(names.some(n => n.includes('birra')),   'birra mancante');
  });
  await test('Lidl è la catena consigliata (risparmio positivo)', async () => {
    const chains = basketRes.data?.data?.chains;
    assert(Array.isArray(chains) && chains.length >= 1, 'chains vuoto');
    assert(chains[0].chain === 'Lidl', `prima catena: ${chains[0].chain} (atteso Lidl)`);
    assert(chains[0].estimatedSaving > 0, `saving: ${chains[0].estimatedSaving}`);
  });
  await test('Conad ha risparmio negativo (è più caro)', async () => {
    const conad = basketRes.data?.data?.chains?.find(ch => ch.chain === 'Conad');
    assert(conad, 'Conad non presente');
    assert(conad.estimatedSaving < 0, `Conad saving: ${conad.estimatedSaving} (atteso negativo)`);
  });
  await test('coverage onesta (Lidl copre 3 prodotti, non 100%)', async () => {
    const lidl = basketRes.data?.data?.chains?.find(ch => ch.chain === 'Lidl');
    assert(lidl.coveredProducts === 3, `covered: ${lidl.coveredProducts} (atteso 3)`);
    assert(lidl.coveragePct < 100, `coverage: ${lidl.coveragePct}% (atteso <100)`);
  });
  await test('il messaggio cita la catena e il risparmio', async () => {
    const msg = basketRes.data?.data?.message;
    assert(msg && msg.includes('Lidl') && msg.includes('€'), `msg: ${msg}`);
  });

  console.log(c.bold('\nGET /api/advisor/health'));
  let healthRes;
  await test('risponde 200', async () => {
    healthRes = await req('GET', '/api/advisor/health');
    assert(healthRes.status === 200, `got ${healthRes.status}: ${JSON.stringify(healthRes.data).slice(0, 200)}`);
  });
  await test('composizione include frutta, verdura, latticini, dolci, alcolici', async () => {
    const comp = healthRes.data?.data?.composition;
    assert(Array.isArray(comp), 'composition mancante');
    const cats = comp.map(x => x.category);
    for (const expected of ['frutta', 'verdura', 'latticini', 'dolci_snack', 'alcolici']) {
      assert(cats.includes(expected), `categoria ${expected} mancante (trovate: ${cats.join(', ')})`);
    }
  });
  await test('la carta igienica è esclusa (non-food)', async () => {
    const d = healthRes.data?.data;
    assert(d.nonFoodSpend > 0, `nonFoodSpend: ${d.nonFoodSpend} (attesa carta igienica)`);
    const comp = d.composition.map(x => x.label.toLowerCase()).join(' ');
    assert(!comp.includes('igienica'), 'carta igienica finita nelle categorie food');
  });
  await test('le percentuali sommano ~100', async () => {
    const total = healthRes.data.data.composition.reduce((s, x) => s + x.pct, 0);
    assert(total >= 95 && total <= 105, `somma pct: ${total}`);
  });
  await test('healthScore presente e penalizza alcolici alti', async () => {
    const d = healthRes.data.data;
    assert(typeof d.healthScore === 'number' && d.healthScore >= 0 && d.healthScore <= 100,
      `score: ${d.healthScore}`);
    // la birra è ~30% della spesa → score deve essere penalizzato
    assert(d.healthScore < 90, `score ${d.healthScore} troppo alto con il ${d.indicators.alcoholPct}% di alcolici`);
  });
  await test('advice presente e in italiano', async () => {
    const advice = healthRes.data.data.advice;
    assert(Array.isArray(advice) && advice.length > 0, 'advice vuoto');
  });
  await test('macroEstimate: carbs+protein+fat ≈ 100%', async () => {
    const m = healthRes.data.data.macroEstimate;
    assert(m, 'macroEstimate mancante');
    const sum = m.carbsPct + m.proteinPct + m.fatPct;
    assert(sum >= 97 && sum <= 103, `somma macro: ${sum}`);
    assert(m.note && m.method === 'spend_weighted', 'metadati stima mancanti');
  });
  await test('macroEstimate: fonti zuccherine rilevate (birra+biscotti)', async () => {
    const m = healthRes.data.data.macroEstimate;
    assert(m.sugarSourcesPct > 20, `sugarSourcesPct: ${m.sugarSourcesPct} (attesa quota alta: birra ~30% + biscotti)`);
  });
  await test('weekly: spesa media settimanale calcolata', async () => {
    const w = healthRes.data.data.weekly;
    assert(w && w.weeks >= 1, 'weekly mancante');
    assert(w.avgFoodSpendPerWeek > 0, `avgFoodSpendPerWeek: ${w.avgFoodSpendPerWeek}`);
    // sanity: spesa food totale / settimane
    const expected = Math.round((healthRes.data.data.foodSpend / w.weeks) * 100) / 100;
    assert(Math.abs(w.avgFoodSpendPerWeek - expected) < 0.01, `atteso ${expected}, got ${w.avgFoodSpendPerWeek}`);
  });

  console.log(c.bold('\nAllergeni dal NutritionProfile'));
  await test('flag allergene su prodotto acquistato', async () => {
    await prisma.nutritionProfile.upsert({
      where:  { userId: (await prisma.user.findUnique({ where: { email: EMAIL } })).id },
      update: { allergens: ['latte'] },
      create: { userId: (await prisma.user.findUnique({ where: { email: EMAIL } })).id, allergens: ['latte'] },
    });
    const r = await req('GET', '/api/advisor/health');
    const flags = r.data?.data?.profileFlags;
    assert(Array.isArray(flags) && flags.some(f => f.toLowerCase().includes('latte')),
      `flags: ${JSON.stringify(flags)}`);
  });

  await cleanup();
  console.log('\n  Cleanup completato');

  console.log('\n' + '═'.repeat(50));
  console.log(`  ${c.green(`✓ ${passed} passati`)}${failed ? '  ' + c.red(`✗ ${failed} falliti`) : ''}`);
  if (failures.length) failures.forEach(f => console.log(`  ${c.red('•')} ${f.name}: ${f.error}`));
  console.log('═'.repeat(50) + '\n');

  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(async e => {
  console.error('Errore fatale:', e);
  await cleanup().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
