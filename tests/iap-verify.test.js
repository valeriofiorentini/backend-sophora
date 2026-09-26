// POST /api/iap/verify-receipt con Apple e database finti: verifica che una
// ricevuta valida attivi Premium e che gli altri casi non lo facciano.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');

function stub(rel, exports) {
  const file = require.resolve(path.join('..', 'src', rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}

let user;
let subs;
const db = {
  user: { update: async ({ data }) => Object.assign(user, data) },
  subscription: {
    upsert: async ({ create }) => { subs.push(create); return create; },
  },
  $transaction: async ops => Promise.all(ops),
};
stub('config/database', db);
stub('utils/appleJws', { verifyAppleJWS: async () => ({}) });

const { verifyReceipt } = require('../src/controllers/iap.controller');

let appleReplies; // risposte in sequenza: [prod, sandbox]
let calls;
global.fetch = async url => {
  calls.push(url);
  return { json: async () => appleReplies.shift() };
};

function call(body) {
  return new Promise(resolve => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ code: this.statusCode, body: b }); return this; },
    };
    verifyReceipt({ userId: 'u1', body }, res);
  });
}

const future = () => String(Date.now() + 30 * 24 * 3600 * 1000);
const past = () => String(Date.now() - 24 * 3600 * 1000);
const tx = (extra = {}) => ({
  product_id: 'com.shopora.premium.monthly',
  original_transaction_id: 'orig-1',
  expires_date_ms: future(),
  ...extra,
});

beforeEach(() => {
  process.env.APPLE_SHARED_SECRET = 'secret';
  user = { id: 'u1', isSubscribed: false };
  subs = [];
  calls = [];
  appleReplies = [];
});

test('senza APPLE_SHARED_SECRET risponde 503 e non attiva nulla (caso che su iOS mostra "Acquisto non riuscito")', async () => {
  delete process.env.APPLE_SHARED_SECRET;
  const r = await call({ receiptData: 'abc' });
  assert.strictEqual(r.code, 503);
  assert.strictEqual(user.isSubscribed, false);
});

test('ricevuta senza receiptData: 400', async () => {
  const r = await call({});
  assert.strictEqual(r.code, 400);
});

test('ricevuta valida in produzione: attiva Premium e salva la subscription', async () => {
  appleReplies = [{ status: 0, latest_receipt_info: [tx()] }];
  const r = await call({ receiptData: 'abc', productId: 'com.shopora.premium.monthly' });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.data.isSubscribed, true);
  assert.strictEqual(user.isSubscribed, true);
  assert.strictEqual(subs[0].provider, 'apple');
  assert.strictEqual(subs[0].status, 'active');
  assert.strictEqual(calls.length, 1);
});

test('ricevuta sandbox (21007, il caso della revisione Apple): riprova su sandbox e attiva Premium', async () => {
  appleReplies = [{ status: 21007 }, { status: 0, latest_receipt_info: [tx()] }];
  const r = await call({ receiptData: 'abc' });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(user.isSubscribed, true);
  assert.strictEqual(calls.length, 2);
  assert.match(calls[1], /sandbox/);
});

test('abbonamento scaduto: non attiva Premium', async () => {
  appleReplies = [{ status: 0, latest_receipt_info: [tx({ expires_date_ms: past() })] }];
  const r = await call({ receiptData: 'abc' });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.data.isSubscribed, false);
  assert.strictEqual(user.isSubscribed, false);
  assert.strictEqual(subs[0].status, 'expired');
});

test('ricevuta rifiutata da Apple (status != 0): 400, nessuna attivazione', async () => {
  appleReplies = [{ status: 21002 }];
  const r = await call({ receiptData: 'abc' });
  assert.strictEqual(r.code, 400);
  assert.strictEqual(user.isSubscribed, false);
});

test('productId diverso da quello nella ricevuta: 400, nessuna attivazione', async () => {
  appleReplies = [{ status: 0, latest_receipt_info: [tx()] }];
  const r = await call({ receiptData: 'abc', productId: 'un.altro.prodotto' });
  assert.strictEqual(r.code, 400);
  assert.strictEqual(user.isSubscribed, false);
});

test('receipt-data arriva a Apple con il segreto condiviso', async () => {
  appleReplies = [{ status: 0, latest_receipt_info: [tx()] }];
  let sent;
  const orig = global.fetch;
  global.fetch = async (url, opts) => { sent = JSON.parse(opts.body); return orig(url, opts); };
  await call({ receiptData: 'abc' });
  global.fetch = orig;
  assert.strictEqual(sent['receipt-data'], 'abc');
  assert.strictEqual(sent.password, 'secret');
});
